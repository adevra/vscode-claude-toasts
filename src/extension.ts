import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { registerAppId, unregisterAppId } from "./appRegistration";
import { ExtensionConfig, readConfig } from "./config";
import { handleFocusUri } from "./focus";
import { startHookServer } from "./hookServer";
import {
  HOOK_SCRIPT_BASENAME,
  installHooksToFile,
  isFullyInstalled,
  removeHooksFromFile,
} from "./hookInstaller";
import { createNotifier } from "./notifier/factory";
import { Notifier } from "./notifier/index";
import { evaluateEvent, ToastGate } from "./notificationPolicy";
import { SessionRegistry } from "./sessionRegistry";
import { StatusBar } from "./statusBar";
import { HookEvent, PolicyContext } from "./types";

const EXT_ID = "adev.vscode-claude-toasts";
const APP_ID = "ClaudeCode.VSCodeToasts";
const APP_DISPLAY_NAME = "Claude Code";
const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

let log!: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log = vscode.window.createOutputChannel("Claude Code Toasts");
  context.subscriptions.push(log);

  let cfg: ExtensionConfig = readConfig();
  const registry = new SessionRegistry();
  const gate = new ToastGate(cfg);
  const statusBar = new StatusBar(registry);
  context.subscriptions.push(statusBar);

  const assetDir = path.join(context.extensionUri.fsPath, "dist");
  const iconPath = deployAsset(context, "icon.png");
  const notifier: Notifier = createNotifier({ assetDir, appId: APP_ID, iconPath, log: (m) => log.appendLine(m) });
  context.subscriptions.push({ dispose: () => notifier.dispose() });

  // --- dormant paths: nothing to toast with -----------------------------
  if (vscode.env.remoteName) {
    log.appendLine(`Running in a remote workspace (${vscode.env.remoteName}); desktop toasts are unavailable. Dormant.`);
    notifyOnce(context, "remote", "Claude Code Toasts can't show desktop toasts in a remote/WSL workspace yet. Running dormant.");
    registerCommands(context, { notifier, cfg: () => cfg, dormant: true });
    return;
  }
  if (!notifier.available) {
    log.appendLine(`No toast backend for ${process.platform}; running dormant.`);
    notifyOnce(context, "platform", `Claude Code Toasts supports Windows for now (${process.platform} is unsupported). Running dormant.`);
    registerCommands(context, { notifier, cfg: () => cfg, dormant: true });
    return;
  }

  // --- register our AUMID so Windows shows/attributes toasts -------------
  try {
    await registerAppId(APP_ID, APP_DISPLAY_NAME, iconPath);
  } catch (e) {
    log.appendLine(`AUMID registration failed: ${(e as Error).message}`);
  }

  // --- copy the hook client into stable globalStorage -------------------
  const hookPath = deployHookScript(context);

  // --- per-window pipe + terminal env injection -------------------------
  const server = startHookServer({
    onEvent: (ev) => void processEvent(ev),
    onLog: (m) => log.appendLine(`[pipe] ${m}`),
  });
  context.subscriptions.push({ dispose: () => server.dispose() });

  const envCol = context.environmentVariableCollection;
  envCol.persistent = false;
  envCol.replace("CLAUDE_TOASTS_PIPE", server.pipePath);
  envCol.replace("CLAUDE_TOASTS_TOKEN", server.token);
  log.appendLine(`pipe ready: ${server.pipePath}`);

  // --- URI handler: toast click -> focus terminal -----------------------
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) => handleFocusUri(uri, registry, (m) => log.appendLine(`[focus] ${m}`)),
    }),
  );

  // --- react to environment changes -------------------------------------
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeToasts")) {
        cfg = readConfig();
        gate.update(cfg);
        log.appendLine("config reloaded");
      }
    }),
    vscode.window.onDidCloseTerminal((t) => {
      registry.onTerminalClosed(t);
      statusBar.refresh();
    }),
  );

  registerCommands(context, { notifier, cfg: () => cfg, hookPath, dormant: false });

  // --- install hooks (with first-run consent) ---------------------------
  await ensureHooks(context, hookPath, false);

  log.appendLine("activated");

  async function processEvent(ev: HookEvent): Promise<void> {
    const name = ev.hook_event_name;
    const sid = ev.session_id ?? "";

    if (name === "SessionStart") {
      registry.onSessionStart(sid, ev.cwd);
      statusBar.refresh();
      return;
    }
    if (name === "UserPromptSubmit") {
      registry.onUserPrompt(sid, ev.cwd, ev.ts);
      return;
    }
    if (name === "SessionEnd") {
      registry.onSessionEnd(sid);
      statusBar.refresh();
      return;
    }

    const info = registry.resolve(sid, ev.cwd);
    const ctx: PolicyContext = {
      windowFocused: vscode.window.state.focused,
      isBoundTerminalActive: !!info.terminal && info.terminal === vscode.window.activeTerminal,
      turnStartedAt: info.turnStartedAt,
      folderName: pickFolderName(ev.cwd),
      config: cfg,
    };

    const result = evaluateEvent(ev, ctx);
    if ("suppressed" in result) {
      log.appendLine(`[${name}] suppressed: ${result.reason}`);
      return;
    }
    const decision = result.decision;
    const admit = gate.admit(decision.dedupKey, Date.now());
    if (!admit.ok) {
      log.appendLine(`[${name}] gated: ${admit.reason}`);
      return;
    }

    const launchUri = await buildLaunchUri(sid);
    await notifier.show({
      kind: decision.kind,
      title: decision.title,
      body: decision.body,
      urgency: decision.urgency,
      sticky: decision.sticky,
      sound: cfg.sound,
      tag: decision.dedupKey,
      launchUri,
    });
    log.appendLine(`[toast] ${decision.title} — ${decision.body}`);
  }
}

export function deactivate(): void {
  // Disposables handle teardown; env collection is non-persistent and clears itself.
}

// --- helpers ----------------------------------------------------------------

function deployHookScript(context: vscode.ExtensionContext): string {
  return deployAsset(context, HOOK_SCRIPT_BASENAME);
}

/** Copy a bundled dist/ asset into stable globalStorage and return its path. */
function deployAsset(context: vscode.ExtensionContext, basename: string): string {
  const dir = context.globalStorageUri.fsPath;
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, basename);
  const src = path.join(context.extensionUri.fsPath, "dist", basename);
  try {
    fs.copyFileSync(src, dest);
  } catch (e) {
    log.appendLine(`could not deploy ${basename}: ${(e as Error).message}`);
  }
  return dest;
}

async function buildLaunchUri(sessionId: string): Promise<string> {
  const plain = vscode.Uri.parse(
    `vscode://${EXT_ID}/focus?session=${encodeURIComponent(sessionId)}`,
  );
  try {
    return (await vscode.env.asExternalUri(plain)).toString();
  } catch {
    return plain.toString();
  }
}

function pickFolderName(cwd: string | null): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].name;
  }
  if (cwd) {
    return path.basename(cwd.replace(/[\\/]+$/, "")) || "Claude";
  }
  return "Claude";
}

interface CommandDeps {
  notifier: Notifier;
  cfg: () => ExtensionConfig;
  hookPath?: string;
  dormant: boolean;
}

function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeToasts.showLog", () => log.show()),
    vscode.commands.registerCommand("claudeToasts.sendTestNotification", async () => {
      if (!deps.notifier.available) {
        vscode.window.showWarningMessage("Claude Code Toasts: no toast backend on this platform.");
        return;
      }
      await deps.notifier.show({
        kind: "complete",
        title: "Claude Code Toasts",
        body: "This is a test notification. If you can see it, you're all set.",
        urgency: "normal",
        sticky: false,
        sound: deps.cfg().sound,
        tag: "test:complete",
      });
      vscode.window.showInformationMessage("Sent a test notification.");
    }),
    vscode.commands.registerCommand("claudeToasts.installHooks", async () => {
      if (!deps.hookPath) {
        vscode.window.showWarningMessage("Claude Code Toasts is dormant here; hooks were not installed.");
        return;
      }
      await ensureHooks(context, deps.hookPath, true);
    }),
    vscode.commands.registerCommand("claudeToasts.removeHooks", async () => {
      try {
        const res = removeHooksFromFile(SETTINGS_PATH);
        await context.globalState.update("hooksConsentGiven", false);
        await unregisterAppId(APP_ID);
        vscode.window.showInformationMessage(
          res.changed ? `Removed Claude Toasts hooks from ${res.path}.` : "No Claude Toasts hooks were present.",
        );
      } catch (e) {
        vscode.window.showErrorMessage(`Claude Code Toasts: ${(e as Error).message}`);
      }
    }),
  );
}

async function ensureHooks(
  context: vscode.ExtensionContext,
  hookPath: string,
  interactive: boolean,
): Promise<void> {
  let alreadyInstalled = false;
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const cur = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8") || "{}");
      alreadyInstalled = isFullyInstalled(cur, hookPath);
    }
  } catch (e) {
    log.appendLine(`could not read settings for install check: ${(e as Error).message}`);
  }

  if (alreadyInstalled && !interactive) {
    return;
  }

  const consentGiven = context.globalState.get<boolean>("hooksConsentGiven", false);
  const consentDeclined = context.globalState.get<boolean>("hooksConsentDeclined", false);

  const doInstall = async () => {
    try {
      const res = installHooksToFile(SETTINGS_PATH, hookPath);
      await context.globalState.update("hooksConsentGiven", true);
      await context.globalState.update("hooksConsentDeclined", false);
      log.appendLine(res.changed ? `installed hooks into ${res.path}` : "hooks already current");
      if (interactive) {
        vscode.window.showInformationMessage(
          "Claude Code Toasts hooks installed. Relaunch any open Claude Code sessions to pick them up.",
        );
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Claude Code Toasts: ${(e as Error).message}`);
    }
  };

  if (interactive || consentGiven) {
    await doInstall();
    return;
  }
  if (consentDeclined) {
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    "Claude Code Toasts adds notification hooks to your ~/.claude/settings.json so it can tell when Claude finishes or needs you. Install them?",
    "Install",
    "Not now",
    "Don't ask again",
  );
  if (choice === "Install") {
    await doInstall();
  } else if (choice === "Don't ask again") {
    await context.globalState.update("hooksConsentDeclined", true);
  }
}

function notifyOnce(context: vscode.ExtensionContext, key: string, message: string): void {
  const stateKey = `notified:${key}`;
  if (context.globalState.get<boolean>(stateKey)) {
    return;
  }
  void context.globalState.update(stateKey, true);
  vscode.window.showInformationMessage(message);
}
