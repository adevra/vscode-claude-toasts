import * as vscode from "vscode";
import { SessionRegistry } from "./sessionRegistry";

export class StatusBar {
  private item: vscode.StatusBarItem;

  constructor(private registry: SessionRegistry) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "claudeToasts.showLog";
    this.refresh();
    this.item.show();
  }

  refresh(): void {
    const n = this.registry.size;
    this.item.text = n > 0 ? `$(bell) Claude ${n}` : "$(bell) Claude";
    const sessions = this.registry.list();
    const lines =
      sessions.length > 0
        ? sessions.map((s) => `• ${s.sessionId.slice(0, 8)} — ${s.cwd ?? "?"}${s.terminal ? "" : " (no terminal)"}`)
        : ["No active Claude sessions"];
    this.item.tooltip = new vscode.MarkdownString(
      ["**Claude Code Toasts**", "", ...lines, "", "_Click to open the log_"].join("\n"),
    );
  }

  dispose(): void {
    this.item.dispose();
  }
}
