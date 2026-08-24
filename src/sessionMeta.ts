import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Session metadata for toasts: which repo/branch a session is in, and what color
 * it should carry. No `vscode` import and no child processes — repo and branch
 * come from reading .git/HEAD, the color from scanning the session transcript
 * for the line Claude Code's /color command appends:
 *   {"type":"agent-color","agentColor":"red","sessionId":"..."}
 */

/** The /color palette. Hexes are the VS Code terminal ANSI shades. */
export const PALETTE: Record<string, string> = {
  red: "#CD3131",
  orange: "#D18616",
  yellow: "#E5C07B",
  green: "#0DBC79",
  cyan: "#11A8CD",
  blue: "#2472C8",
  purple: "#BC3FBC",
  pink: "#E064BA",
};

export interface RepoInfo {
  /** Basename of the repository root directory. */
  repo: string;
  /** Current branch, or a short commit hash when detached; empty if unreadable. */
  branch: string;
}

const MAX_WALK_UP = 24;

/** Walk up from cwd to the repository root and read HEAD. Null outside a repo. */
export function findRepoInfo(cwd: string | null | undefined): RepoInfo | null {
  if (!cwd) return null;
  let dir = path.resolve(cwd);
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const gitPath = path.join(dir, ".git");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(gitPath);
    } catch {
      stat = undefined;
    }
    if (stat) {
      const gitDir = stat.isFile() ? resolveGitFile(gitPath, dir) : gitPath;
      return { repo: path.basename(dir), branch: gitDir ? readBranch(gitDir) : "" };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** A .git *file* (worktree/submodule) holds "gitdir: <path>". */
function resolveGitFile(gitFile: string, baseDir: string): string | null {
  try {
    const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(gitFile, "utf8"));
    if (!m) return null;
    return path.resolve(baseDir, m[1].trim());
  } catch {
    return null;
  }
}

function readBranch(gitDir: string): string {
  try {
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1];
    return head.slice(0, 8); // detached
  } catch {
    return "";
  }
}

/** Stable per-repo color: hash the name into the palette. */
export function autoColor(name: string): string {
  const keys = Object.keys(PALETTE);
  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  }
  return keys[Math.abs(h) % keys.length];
}

interface ScanState {
  offset: number;
  color: string | null;
}

/**
 * Incrementally scan a session transcript for the newest agent-color line. Only
 * bytes appended since the previous scan are read, so per-toast cost is O(new
 * transcript output), not O(file size).
 */
export class SessionColorReader {
  private states = new Map<string, ScanState>();

  /** Current /color for the session, or null if never set / set to a non-palette value. */
  read(sessionId: string, transcriptPath: string | null | undefined): string | null {
    if (!transcriptPath) return this.states.get(sessionId)?.color ?? null;
    const state = this.states.get(sessionId) ?? { offset: 0, color: null };

    let size: number;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      return state.color;
    }
    if (size < state.offset) {
      state.offset = 0; // rewritten/rotated: rescan
      state.color = null;
    }
    if (size > state.offset) {
      try {
        const fd = fs.openSync(transcriptPath, "r");
        try {
          const len = size - state.offset;
          const buf = Buffer.alloc(Math.min(len, 8 * 1024 * 1024));
          const read = fs.readSync(fd, buf, 0, buf.length, state.offset);
          const chunk = buf.toString("utf8", 0, read);
          const lastNl = chunk.lastIndexOf("\n");
          const complete = lastNl >= 0 ? chunk.slice(0, lastNl + 1) : "";
          state.offset += Buffer.byteLength(complete, "utf8");
          const color = extractLastAgentColor(complete);
          if (color !== undefined) {
            state.color = color;
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        /* transient read error; keep last known color */
      }
    }
    this.states.set(sessionId, state);
    return state.color;
  }

  drop(sessionId: string): void {
    this.states.delete(sessionId);
  }
}

/**
 * Newest agent-color in the chunk. Returns undefined when the chunk has none
 * (keep previous), null when the newest value is not a palette color (e.g.
 * "default" — fall back to the auto color).
 */
function extractLastAgentColor(chunk: string): string | null | undefined {
  let result: string | null | undefined;
  let idx = 0;
  for (;;) {
    const at = chunk.indexOf('"agent-color"', idx);
    if (at < 0) break;
    const lineStart = chunk.lastIndexOf("\n", at) + 1;
    const lineEnd = chunk.indexOf("\n", at);
    const line = chunk.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
    idx = at + 1;
    try {
      const obj = JSON.parse(line);
      if (obj?.type === "agent-color") {
        const c = typeof obj.agentColor === "string" ? obj.agentColor : "";
        result = c in PALETTE ? c : null;
      }
    } catch {
      /* partial or unrelated line */
    }
  }
  return result;
}

/**
 * The color for a session's toasts: explicit /color first, then the stable
 * per-repo (or per-folder) auto color.
 */
export function resolveAccentColor(
  explicit: string | null,
  repoOrFolder: string | null | undefined,
): string | null {
  if (explicit && explicit in PALETTE) return explicit;
  if (repoOrFolder) return autoColor(repoOrFolder);
  return null;
}
