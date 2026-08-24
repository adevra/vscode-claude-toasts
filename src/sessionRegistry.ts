import * as vscode from "vscode";

export interface SessionInfo {
  sessionId: string;
  cwd: string | null;
  terminal?: vscode.Terminal;
  turnStartedAt?: number;
  /** Set when a completion toast fires; cleared when the next turn starts. */
  completedToastShownThisTurn?: boolean;
  /** Window handle of the standalone terminal hosting this session, if external. */
  externalHwnd?: string;
  /** True once the ppid ancestry walk has resolved this session's home. */
  bindingResolved?: boolean;
}

/** Normalize a path for loose comparison: lowercase, forward slashes, no trailing slash. */
function normPath(p: string | null | undefined): string {
  if (!p) return "";
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Tracks which VS Code terminal each Claude session lives in, plus when the
 * current turn started. Binding is a heuristic: the active terminal at
 * SessionStart, checked against the event cwd, with a fallback scan of all
 * terminals by shell-integration cwd.
 */
export class SessionRegistry {
  private sessions = new Map<string, SessionInfo>();

  onSessionStart(sessionId: string, cwd: string | null): void {
    const terminal = this.pickTerminal(cwd);
    this.sessions.set(sessionId, { sessionId, cwd, terminal });
  }

  onUserPrompt(sessionId: string, cwd: string | null, ts: number): void {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.turnStartedAt = ts;
      existing.completedToastShownThisTurn = false;
      if (!existing.terminal) {
        existing.terminal = this.pickTerminal(cwd ?? existing.cwd);
      }
    } else {
      this.sessions.set(sessionId, { sessionId, cwd, terminal: this.pickTerminal(cwd), turnStartedAt: ts });
    }
  }

  /** Return known info, lazily binding a terminal by cwd if the session is unknown. */
  resolve(sessionId: string, cwd: string | null): SessionInfo {
    let info = this.sessions.get(sessionId);
    if (!info) {
      info = { sessionId, cwd, terminal: this.pickTerminal(cwd) };
      this.sessions.set(sessionId, info);
    } else if (!info.terminal) {
      info.terminal = this.pickTerminal(cwd ?? info.cwd);
    }
    return info;
  }

  /** Exact binding from the process-ancestry walk; overrides the cwd heuristic. */
  applyBinding(sessionId: string, terminal: vscode.Terminal | undefined, externalHwnd: string | undefined): void {
    const info = this.sessions.get(sessionId);
    if (!info) {
      return;
    }
    info.bindingResolved = true;
    if (terminal) {
      info.terminal = terminal;
      info.externalHwnd = undefined;
    } else if (externalHwnd) {
      info.terminal = undefined;
      info.externalHwnd = externalHwnd;
    }
  }

  markCompletedToastShown(sessionId: string): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.completedToastShownThisTurn = true;
    }
  }

  onSessionEnd(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  onTerminalClosed(terminal: vscode.Terminal): void {
    for (const info of this.sessions.values()) {
      if (info.terminal === terminal) {
        info.terminal = undefined;
      }
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()];
  }

  private pickTerminal(cwd: string | null): vscode.Terminal | undefined {
    const active = vscode.window.activeTerminal;
    const target = normPath(cwd);
    if (active) {
      const activeCwd = normPath(active.shellIntegration?.cwd?.fsPath);
      if (!target || !activeCwd || activeCwd === target) {
        return active;
      }
    }
    // Active terminal is elsewhere; scan for a cwd match.
    if (target) {
      for (const t of vscode.window.terminals) {
        if (normPath(t.shellIntegration?.cwd?.fsPath) === target) {
          return t;
        }
      }
    }
    return active;
  }
}
