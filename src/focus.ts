import { execFile } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { FocusResult, parseFocusOutput, rankCandidates } from "./focusParse";
import { SessionRegistry } from "./sessionRegistry";

export interface FocusDeps {
  /** Directory holding the bundled .ps1 helpers (dist/). */
  assetDir: string;
  registry: SessionRegistry;
  log(message: string): void;
}

const RAISE_TIMEOUT_MS = 5000;
const FOCUS_CONFIRM_MS = 400;
/**
 * VS Code often raises itself while handling the vscode:// URI — the Code.exe
 * spawned by the toast click carries foreground rights and hands them to the
 * running window. That self-raise lands AFTER this handler starts, so raising
 * immediately produces a visible double raise. Wait for it first; run the Win32
 * ladder only if the window still isn't focused.
 */
const SELF_RAISE_WAIT_MS = 500;

/**
 * Handle a toast click delivered as a vscode:// URI:
 *   vscode://adev.vscode-claude-toasts/focus?session=<id>
 *
 * VS Code routes the URI to this window, but it does not raise it: Windows gives
 * foreground rights to the Code.exe that the shell spawned to forward the URI,
 * and that process exits immediately. So we reveal the terminal and raise the
 * window ourselves.
 */
export function handleFocusUri(uri: vscode.Uri, deps: FocusDeps): void {
  if (uri.path !== "/focus") {
    deps.log(`ignoring uri path: ${uri.path}`);
    return;
  }
  const params = new URLSearchParams(uri.query);

  // A session in a standalone terminal: raise that terminal's window instead of
  // VS Code. The hwnd travels in the URI so ANY window that receives the click
  // can act on it, without needing the session in its own registry.
  const externalHwnd = params.get("hwnd");
  if (externalHwnd && /^\d+$/.test(externalHwnd)) {
    deps.log(`raising external terminal window (hwnd ${externalHwnd})`);
    void raiseExternal(deps, externalHwnd);
    return;
  }

  const sessionId = params.get("session");
  if (sessionId) {
    const info = deps.registry.list().find((s) => s.sessionId === sessionId);
    if (info?.terminal) {
      info.terminal.show(false);
    } else {
      deps.log(`clicked toast for session ${sessionId} but no terminal is bound`);
    }
  }
  void raiseWindow(deps);
}

/** Raise a non-VS-Code window (a standalone terminal) by handle. */
async function raiseExternal(deps: FocusDeps, hwnd: string): Promise<void> {
  const result = await run(deps, ["-Mode", "raise", "-Hwnd", hwnd]);
  if (result.foreground) {
    deps.log(`external terminal raised via ${result.strategy}`);
  } else {
    deps.log("external terminal did not take focus (window may be gone)");
  }
}

/** Bring this VS Code window to the foreground (Windows only; no-op elsewhere). */
export async function raiseWindow(deps: FocusDeps): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  if (vscode.window.state.focused) {
    deps.log("window already focused; no raise needed");
    return;
  }
  if (await confirmFocused(SELF_RAISE_WAIT_MS)) {
    deps.log("window raised itself during URI activation; skipping the Win32 raise");
    return;
  }
  const titleHint = vscode.workspace.name;
  if (!titleHint) {
    deps.log("no workspace name available; cannot identify the window to raise");
    return;
  }

  const first = await run(deps, ["-Mode", "auto", "-TitleContains", titleHint]);
  if (first.raised) {
    if (first.foreground) {
      deps.log(`raised window via ${first.strategy}`);
    } else {
      deps.log("Windows refused every raise strategy; the window stayed behind");
    }
    return;
  }
  if (first.candidates.length === 0) {
    deps.log(`no VS Code window title contained "${titleHint}"`);
    return;
  }

  // Several windows share this folder name. Raise them one at a time, most
  // likely first, and let VS Code itself tell us which one is ours.
  const ordered = rankCandidates(first.candidates, activeEditorHint());
  deps.log(`${ordered.length} windows match "${titleHint}"; disambiguating by focus check`);

  for (const candidate of ordered) {
    await run(deps, ["-Mode", "raise", "-Hwnd", candidate.hwnd]);
    if (await confirmFocused(FOCUS_CONFIRM_MS)) {
      deps.log(`raised the correct window: ${candidate.title}`);
      return;
    }
    deps.log(`not our window: ${candidate.title}`);
  }
  deps.log("could not identify this window among the candidates");
}

/** Basename of the active editor; VS Code puts it at the front of the title. */
function activeEditorHint(): string | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  return doc ? path.basename(doc.fileName) : undefined;
}

/** Resolve true if this window reports focus within the timeout. */
function confirmFocused(timeoutMs: number): Promise<boolean> {
  if (vscode.window.state.focused) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const sub = vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        clearTimeout(timer);
        sub.dispose();
        resolve(true);
      }
    });
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(vscode.window.state.focused);
    }, timeoutMs);
  });
}

function run(deps: FocusDeps, args: string[]): Promise<FocusResult> {
  const script = path.join(deps.assetDir, "focus-window.ps1");
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { timeout: RAISE_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          deps.log(`focus helper failed: ${err.message} ${(stderr ?? "").trim()}`);
          resolve({ candidates: [], raised: false, foreground: false, strategy: "" });
          return;
        }
        resolve(parseFocusOutput(stdout ?? ""));
      },
    );
  });
}
