import { execFile } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { SessionRegistry } from "./sessionRegistry";

export interface FocusDeps {
  /** Directory holding the bundled .ps1 helpers (dist/). */
  assetDir: string;
  registry: SessionRegistry;
  log(message: string): void;
}

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
  const sessionId = new URLSearchParams(uri.query).get("session");
  if (sessionId) {
    const info = deps.registry.list().find((s) => s.sessionId === sessionId);
    if (info?.terminal) {
      info.terminal.show(false);
    } else {
      deps.log(`clicked toast for session ${sessionId} but no terminal is bound`);
    }
  }
  raiseWindow(deps);
}

/** Bring this VS Code window to the foreground (Windows only; no-op elsewhere). */
export function raiseWindow(deps: FocusDeps): void {
  if (process.platform !== "win32") {
    return;
  }
  if (vscode.window.state.focused) {
    deps.log("window already focused; no raise needed");
    return;
  }
  const title = vscode.workspace.name;
  if (!title) {
    deps.log("no workspace name available; cannot identify the window to raise");
    return;
  }
  const script = path.join(deps.assetDir, "focus-window.ps1");
  execFile(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-TitleContains", title],
    { timeout: 5000, windowsHide: true },
    (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ?? ""}`.trim().replace(/\s+/g, " ");
      if (err) {
        deps.log(`raise window failed (${err.message}) ${out}`);
      } else {
        deps.log(`raise window: ${out}`);
      }
    },
  );
}
