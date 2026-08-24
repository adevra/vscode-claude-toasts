/** Pure helpers for the window-raise helper. No `vscode` import, so unit-testable. */

export interface Candidate {
  hwnd: string;
  title: string;
}

export interface FocusResult {
  candidates: Candidate[];
  raised: boolean;
  foreground: boolean;
}

/** Parse the machine-readable output of focus-window.ps1. */
export function parseFocusOutput(stdout: string): FocusResult {
  const candidates: Candidate[] = [];
  let raised = false;
  let foreground = false;
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("hwnd=")) {
      const rest = t.slice("hwnd=".length);
      const sep = rest.indexOf("|title=");
      const hwnd = sep >= 0 ? rest.slice(0, sep) : rest;
      const title = sep >= 0 ? rest.slice(sep + "|title=".length) : "";
      if (hwnd) {
        candidates.push({ hwnd, title });
      }
    } else if (t.startsWith("raised=")) {
      raised = true;
    } else if (t.startsWith("foreground=")) {
      foreground = t.endsWith("True");
    }
  }
  return { candidates, raised, foreground };
}

/**
 * When several windows share a folder name, the one whose title also shows our
 * active editor is most likely ours. This only orders the attempts — correctness
 * comes from asking VS Code which window actually took focus.
 */
export function rankCandidates(candidates: Candidate[], editorHint?: string): Candidate[] {
  if (!editorHint) {
    return [...candidates];
  }
  return [...candidates].sort((a, b) => {
    const aHit = a.title.includes(editorHint) ? 1 : 0;
    const bHit = b.title.includes(editorHint) ? 1 : 0;
    return bHit - aHit;
  });
}
