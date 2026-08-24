import * as vscode from "vscode";
import { SessionRegistry } from "./sessionRegistry";

/**
 * Handle a toast click delivered as a vscode:// URI. VS Code has already focused
 * this window by the time the handler runs, so the job here is to reveal the
 * terminal that belongs to the clicked session.
 *
 * URI shape: vscode://adev.vscode-claude-toasts/focus?session=<id>
 */
export function handleFocusUri(uri: vscode.Uri, registry: SessionRegistry, log: (m: string) => void): void {
  if (uri.path !== "/focus") {
    log(`ignoring uri path: ${uri.path}`);
    return;
  }
  const params = new URLSearchParams(uri.query);
  const sessionId = params.get("session");
  if (!sessionId) {
    return;
  }
  const info = registry.list().find((s) => s.sessionId === sessionId);
  if (info?.terminal) {
    info.terminal.show(false);
  } else {
    log(`clicked toast for session ${sessionId} but no terminal is bound`);
  }
}
