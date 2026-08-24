/**
 * Parsing and decisions for session-window.ps1 output — which VS Code terminal
 * (exact, by shell PID) or external terminal window a Claude session lives in.
 * Pure: no vscode import, no I/O.
 */

export interface Ancestor {
  pid: number;
  name: string;
  /** Decimal HWND of the process's visible top-level window; "0" when none. */
  hwnd: string;
}

/** Parse "anc=<pid>|<name>|<hwnd>" lines, child first. */
export function parseAncestry(stdout: string): Ancestor[] {
  const out: Ancestor[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("anc=")) continue;
    const [pidStr, name, hwnd] = t.slice("anc=".length).split("|");
    const pid = Number(pidStr);
    if (Number.isInteger(pid) && pid > 0 && name) {
      out.push({ pid, name, hwnd: hwnd && hwnd !== "0" ? hwnd : "0" });
    }
  }
  return out;
}

export type SessionBinding =
  | { kind: "terminal"; shellPid: number }
  | { kind: "external"; hwnd: string }
  | { kind: "unknown" };

/**
 * Decide where a session lives. A VS Code terminal match wins (an ancestor is
 * the terminal's shell process); otherwise the nearest ancestor that owns a
 * visible window is the standalone terminal to raise on toast click. Ancestry
 * can carry pid-reuse noise past the real terminal host, so the first match
 * from the child end is the trustworthy one.
 */
export function decideBinding(chain: Ancestor[], vscodeTerminalPids: Set<number>): SessionBinding {
  for (const a of chain) {
    if (vscodeTerminalPids.has(a.pid)) {
      return { kind: "terminal", shellPid: a.pid };
    }
  }
  for (const a of chain) {
    if (a.hwnd !== "0") {
      return { kind: "external", hwnd: a.hwnd };
    }
  }
  return { kind: "unknown" };
}
