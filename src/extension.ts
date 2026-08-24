import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { registerAppId, unregisterAppId } from "./appRegistration";
import { ExtensionConfig, readConfig } from "./config";
import { handleFocusUri } from "./focus";
import { Respond, startHookServer } from "./hookServer";
import {
  HOOK_SCRIPT_BASENAME,
  installHooksToFile,
  isFullyInstalled,
  removeHooksFromFile,
} from "./hookInstaller";
import { pruneDeadEntries, removeLiveEntry, writeLiveEntry } from "./liveRegistry";
import { decideBinding, parseAncestry } from "./processTree";
import { createNotifier } from "./notifier/factory";
import { Notifier } from "./notifier/index";
import { evaluateEvent, evaluatePermissionRequest, ToastGate } from "./notificationPolicy";
import { MuteStore } from "./muteStore";
import { findRepoInfo, PALETTE, resolveAccentColor, SessionColorReader } from "./sessionMeta";
import { SessionRegistry } from "./sessionRegistry";
import { StatusBar } from "./statusBar";
import { HookEvent, PolicyContext, ToastAction } from "./types";

const EXT_ID = "adev.vscode-claude-toasts";
const APP_ID = "ClaudeCode.VSCodeToasts";
const APP_DISPLAY_NAME = "Claude Code";
const PERMISSION_WAIT_MS = 25000;
const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

let log!: vscode.LogOutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log = vscode.window.createOutputChannel("Claude Code Toasts", { log: true });
  context.subscriptions.push(log);

  let cfg: ExtensionConfig = readConfig();
  const registry = new SessionRegistry();
  const gate = new ToastGate(cfg);
  const mutes = new MuteStore();
  const colorReader = new SessionColorReader();
  const pendingPermissions = new Map<string, { respond: Respond; timer: NodeJS.Timeout; tag?: string }>();
  let permissionSeq = 0;
  const statusBar = new StatusBar(registry);
  context.subscriptions.push(statusBar);

  const assetDir = path.join(context.extensionUri.fsPath, "dist");
  const iconPath = deployAsset(context, "icon.png");
  const notifier: Notifier = createNotifier({ assetDir, appId: APP_ID, log: (m) => log.appendLine(m) });
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
    onEvent: (ev, respond) => void processEvent(ev, respond),
    onLog: (m) => log.appendLine(`[pipe] ${m}`),
  });
  context.subscriptions.push({ dispose: () => server.dispose() });

  const envCol = context.environmentVariableCollection;
  envCol.persistent = false;
  envCol.replace("CLAUDE_TOASTS_PIPE", server.pipePath);
  envCol.replace("CLAUDE_TOASTS_TOKEN", server.token);
  log.appendLine(`pipe ready: ${server.pipePath}`);

  // Publish this window to the live registry so terminals whose injected pipe
  // address went stale (extension reload) can still find us.
  const storageDir = context.globalStorageUri.fsPath;
  const pruned = pruneDeadEntries(storageDir, process.pid);
  if (pruned > 0) {
    log.appendLine(`pruned ${pruned} dead window entr${pruned === 1 ? "y" : "ies"}`);
  }
  ensureColorStrips(storageDir);
  const liveFile = writeLiveEntry(storageDir, {
    pipe: server.pipePath,
    token: server.token,
    pid: process.pid,
    folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
  });
  context.subscriptions.push({ dispose: () => removeLiveEntry(liveFile) });

  // --- URI handler: toast click -> focus terminal -----------------------
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) => routeUri(uri),
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

  registerCommands(context, {
    notifier,
    cfg: () => cfg,
    hookPath,
    dormant: false,
    diagnostics: () => [
      `pipe        : ${server.pipePath}`,
      `registry    : ${path.join(storageDir, "live")}`,
      `hook script : ${hookPath}`,
      `sessions    : ${registry.size}`,
      ...registry
        .list()
        .map(
          (s) =>
            `  - ${s.sessionId.slice(0, 8)} cwd=${s.cwd ?? "?"} binding=${
              s.bindingKind === "terminal"
                ? "vscode-terminal"
                : s.bindingKind === "external"
                  ? `external(hwnd ${s.externalHwnd})`
                  : s.bindingKind === "unknown"
                    ? "background (cwd fallback)"
                    : s.terminal
                      ? "heuristic terminal"
                      : "unresolved"
            }`,
        ),
      `window focus: ${vscode.window.state.focused}`,
      `config      : ${JSON.stringify(cfg)}`,
    ],
  });

  // --- install hooks (with first-run consent) ---------------------------
  await ensureHooks(context, hookPath, false);

  log.appendLine("activated");

  function routeUri(uri: vscode.Uri): void {
    const params = new URLSearchParams(uri.query);
    if (uri.path === "/permission") {
      const id = params.get("id");
      const decision = params.get("decision");
      if (id && decision) {
        resolvePermission(id, decision === "allow" ? "allow" : "deny");
      }
      return;
    }
    if (uri.path === "/mute") {
      const minutes = Math.max(1, Number(params.get("minutes") ?? "30"));
      const until = Date.now() + minutes * 60_000;
      const session = params.get("session");
      if (params.get("scope") === "all" || !session) {
        mutes.muteGlobal(until);
        log.appendLine(`[mute] all sessions for ${minutes}m`);
        vscode.window.showInformationMessage(`Claude Toasts muted for ${minutes} minutes.`);
      } else {
        mutes.muteSession(session, until);
        log.appendLine(`[mute] session ${session.slice(0, 8)} for ${minutes}m`);
        vscode.window.showInformationMessage(`Claude Toasts muted for this session for ${minutes} minutes.`);
      }
      return;
    }
    handleFocusUri(uri, { assetDir, registry, log: (m) => log.appendLine(`[focus] ${m}`) });
  }

  function resolvePermission(id: string, decision: "allow" | "deny"): void {
    const pending = pendingPermissions.get(id);
    if (!pending) {
      log.appendLine(`[permission] ${decision} arrived too late for ${id} (already resolved or timed out)`);
      vscode.window.showWarningMessage("That permission request already timed out; answer it in the terminal.");
      return;
    }
    clearTimeout(pending.timer);
    pendingPermissions.delete(id);
    if (pending.tag) {
      void notifier.hide(pending.tag);
    }
    pending.respond({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        permissionDecision: decision,
        permissionDecisionReason: `${decision === "allow" ? "Approved" : "Denied"} from a desktop notification`,
      },
    });
    log.appendLine(`[permission] ${decision} for ${id}`);
  }

  function escalate(respond: Respond, reason: string): void {
    log.appendLine(`[PermissionRequest] escalated to the terminal: ${reason}`);
    respond({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        permissionDecision: "escalate",
        permissionDecisionReason: reason,
      },
    });
  }

  function muteActions(sessionId: string): ToastAction[] {
    return [{ content: "Mute 30m", uri: muteUri(sessionId, 30) }];
  }

  async function handlePermissionRequest(ev: HookEvent, respond: Respond): Promise<void> {
    const sid = ev.session_id ?? "";
    const info = registry.resolve(sid, ev.cwd);
    const ctx = buildContext(ev, info);
    const id = `p${++permissionSeq}`;

    const plan = evaluatePermissionRequest(ev, ctx, (sessionId) => [
      { content: "Allow", uri: permissionUri(id, "allow") },
      { content: "Deny", uri: permissionUri(id, "deny") },
      { content: "Mute 30m", uri: muteUri(sessionId, 30) },
    ]);

    if ("escalate" in plan) {
      escalate(respond, plan.reason);
      return;
    }

    // Hold the hook open until the toast is answered. Claude Code cancels us at
    // its own timeout and falls back to the terminal prompt, so we answer a bit
    // sooner to keep control of the message.
    const timer = setTimeout(() => {
      pendingPermissions.delete(id);
      escalate(respond, "no answer from the desktop notification in time");
    }, PERMISSION_WAIT_MS);
    pendingPermissions.set(id, { respond, timer, tag: plan.toast.dedupKey });

    await notifier.show({
      kind: "permission",
      title: plan.toast.title,
      body: plan.toast.body,
      urgency: plan.toast.urgency,
      sticky: plan.toast.sticky,
      sound: cfg.sound,
      tag: plan.toast.dedupKey,
      launchUri: await buildLaunchUri(sid),
      actions: plan.toast.actions,
      attribution: plan.toast.attribution,
      stripPath: stripPathFor(context, plan.toast.accentColor),
    });
    log.appendLine(`[permission] asked: ${plan.toast.body}`);
  }

  /**
   * Walk the process ancestry from the Claude CLI pid to find where the session
   * actually lives: an exact VS Code terminal (ancestor pid == the terminal's
   * shell pid) or a standalone terminal window to raise on toast click.
   */
  async function resolveBinding(sessionId: string, claudePid: number | null | undefined): Promise<void> {
    if (!claudePid || process.platform !== "win32") {
      return;
    }
    try {
      const terminals = vscode.window.terminals;
      const pids = await Promise.all(terminals.map((t) => t.processId));
      const byPid = new Map<number, vscode.Terminal>();
      pids.forEach((pid, i) => {
        if (typeof pid === "number") {
          byPid.set(pid, terminals[i]);
        }
      });

      const script = path.join(assetDir, "session-window.ps1");
      const stdout = await new Promise<string>((resolve) => {
        execFile(
          "powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-StartPid", String(claudePid)],
          { timeout: 15000, windowsHide: true },
          (_err, out) => resolve(out ?? ""),
        );
      });

      const binding = decideBinding(parseAncestry(stdout), new Set(byPid.keys()));
      if (binding.kind === "terminal") {
        registry.applyBinding(sessionId, byPid.get(binding.shellPid), undefined);
        log.appendLine(`[bind] ${sessionId.slice(0, 8)} -> VS Code terminal (shell pid ${binding.shellPid})`);
      } else if (binding.kind === "external") {
        registry.applyBinding(sessionId, undefined, binding.hwnd);
        log.appendLine(`[bind] ${sessionId.slice(0, 8)} -> external terminal window (hwnd ${binding.hwnd})`);
      } else {
        registry.applyBinding(sessionId, undefined, undefined);
        log.appendLine(
          `[bind] ${sessionId.slice(0, 8)} -> no terminal in ancestry (background job); using cwd watching fallback`,
        );
      }
      statusBar.refresh();
    } catch (e) {
      log.appendLine(`[bind] resolution failed: ${(e as Error).message}`);
    }
  }

  function buildContext(
    ev: HookEvent,
    info: {
      terminal?: vscode.Terminal;
      turnStartedAt?: number;
      completedToastShownThisTurn?: boolean;
      bindingKind?: "terminal" | "external" | "unknown";
    },
  ): PolicyContext {
    const repo = findRepoInfo(ev.cwd);
    const explicit = colorReader.read(ev.session_id ?? "", ev.transcript_path);
    const exactActive = !!info.terminal && info.terminal === vscode.window.activeTerminal;
    // Background jobs (and sessions the walk hasn't classified) have no reliable
    // terminal link, so "watching" falls back to: the active terminal's cwd is
    // the session's cwd. Exactly-bound and external sessions never use this.
    const cwdWatch =
      info.bindingKind !== "terminal" &&
      info.bindingKind !== "external" &&
      terminalCwdMatches(vscode.window.activeTerminal, ev.cwd);
    return {
      windowFocused: vscode.window.state.focused,
      isBoundTerminalActive: info.bindingKind === "external" ? false : exactActive || cwdWatch,
      turnStartedAt: info.turnStartedAt,
      folderName: pickFolderName(ev.cwd),
      completedToastShownThisTurn: info.completedToastShownThisTurn === true,
      muted: mutes.isMuted(ev.session_id ?? "", Date.now()),
      attribution: repo ? (repo.branch ? `${repo.repo} · ${repo.branch}` : repo.repo) : "",
      accentColor: resolveAccentColor(explicit, repo?.repo ?? pickFolderName(ev.cwd)),
      config: cfg,
    };
  }

  async function processEvent(ev: HookEvent, respond: Respond): Promise<void> {
    const name = ev.hook_event_name;
    const sid = ev.session_id ?? "";

    if (name === "SessionStart") {
      registry.onSessionStart(sid, ev.cwd);
      void resolveBinding(sid, ev.claude_pid);
      statusBar.refresh();
      return;
    }
    if (name === "UserPromptSubmit") {
      registry.onUserPrompt(sid, ev.cwd, ev.ts);
      return;
    }
    if (name === "SessionEnd") {
      registry.onSessionEnd(sid);
      colorReader.drop(sid);
      statusBar.refresh();
      return;
    }

    if (name === "PermissionRequest") {
      await handlePermissionRequest(ev, respond);
      return;
    }

    const info = registry.resolve(sid, ev.cwd);
    if (!info.bindingKind) {
      void resolveBinding(sid, ev.claude_pid);
    }
    const ctx = buildContext(ev, info);

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
      actions: muteActions(sid),
      attribution: decision.attribution,
      stripPath: stripPathFor(context, decision.accentColor),
    });
    if (decision.kind === "complete") {
      registry.markCompletedToastShown(sid);
    }
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
  diagnostics?: () => string[];
}

function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeToasts.showLog", () => log.show()),
    vscode.commands.registerCommand("claudeToasts.diagnostics", async () => {
      const lines = deps.diagnostics ? deps.diagnostics() : ["Claude Toasts is dormant in this window."];
      log.appendLine("");
      log.appendLine("=== diagnostics ===");
      lines.forEach((l) => log.appendLine(l));
      log.show();
    }),
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

function permissionUri(id: string, decision: "allow" | "deny"): string {
  return `vscode://${EXT_ID}/permission?id=${encodeURIComponent(id)}&decision=${decision}`;
}

function muteUri(sessionId: string, minutes: number): string {
  return `vscode://${EXT_ID}/mute?session=${encodeURIComponent(sessionId)}&minutes=${minutes}`;
}

/** Absolute path to the pre-generated strip PNG for a palette color, if present. */
function stripPathFor(context: vscode.ExtensionContext, color: string | null | undefined): string | undefined {
  if (!color) {
    return undefined;
  }
  const p = path.join(context.globalStorageUri.fsPath, "strips", `strip-${color}.png`);
  return fs.existsSync(p) ? p : undefined;
}

/** Generate the palette strip PNGs into globalStorage once per install. */
function ensureColorStrips(storageDir: string): void {
  const dir = path.join(storageDir, "strips");
  const missing = Object.keys(PALETTE).some((c) => !fs.existsSync(path.join(dir, `strip-${c}.png`)));
  if (!missing) {
    return;
  }
  const spec = Object.entries(PALETTE)
    .map(([name, hex]) => `${name}=${hex}`)
    .join(";");
  const script = path.join(__dirname, "make-strips.ps1");
  execFile(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-OutDir", dir, "-Spec", spec],
    { timeout: 15000, windowsHide: true },
    (err) => {
      if (err) {
        log.appendLine(`strip generation failed: ${err.message}`);
      } else {
        log.appendLine("color strips generated");
      }
    },
  );
}

/** Does this terminal's shell-integration cwd equal the session's cwd? */
function terminalCwdMatches(terminal: vscode.Terminal | undefined, cwd: string | null): boolean {
  const termCwd = terminal?.shellIntegration?.cwd?.fsPath;
  if (!termCwd || !cwd) {
    return false;
  }
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(termCwd) === norm(cwd);
}
