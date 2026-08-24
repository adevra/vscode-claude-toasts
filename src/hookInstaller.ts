import * as fs from "node:fs";
import * as path from "node:path";

export const HOOK_SCRIPT_BASENAME = "claude-toasts-hook.js";
export const MANAGED_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "Notification",
  "SessionEnd",
] as const;

type Json = Record<string, unknown>;

interface HookEntry {
  type?: string;
  command?: string;
  args?: unknown[];
  async?: boolean;
  timeout?: number;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
  [k: string]: unknown;
}

function basename(p: unknown): string {
  return typeof p === "string" ? path.basename(p.replace(/\\/g, "/")) : "";
}

/** A hook entry is ours if it is a command hook whose script is our hook client. */
function isOurEntry(h: unknown): boolean {
  const e = h as HookEntry;
  return (
    !!e &&
    e.type === "command" &&
    Array.isArray(e.args) &&
    basename(e.args[0]) === HOOK_SCRIPT_BASENAME
  );
}

/** A group is ours if it exists solely to hold our hook (all its hooks are ours). */
function isOurGroup(g: unknown): boolean {
  const group = g as HookGroup;
  if (!group || !Array.isArray(group.hooks) || group.hooks.length === 0) {
    return false;
  }
  return group.hooks.every(isOurEntry);
}

function buildEntry(scriptPath: string): HookEntry {
  return { type: "command", command: "node", args: [scriptPath], async: true, timeout: 5 };
}

/** Deep clone via JSON so callers never share references with the input. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/**
 * Return settings with our hooks present and correct for every managed event.
 * Appends to (never replaces) existing user hooks, and removes any stale or
 * duplicate copies of our own entries first so it is idempotent and self-healing.
 */
export function applyInstall(input: Json, scriptPath: string): { settings: Json; changed: boolean } {
  const before = JSON.stringify(input);
  const settings = clone(input);
  const hooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Record<
    string,
    HookGroup[]
  >;
  settings.hooks = hooks;

  for (const event of MANAGED_EVENTS) {
    const arr: HookGroup[] = Array.isArray(hooks[event]) ? hooks[event] : [];
    const withoutOurs = arr.filter((g) => !isOurGroup(g));
    withoutOurs.push({ hooks: [buildEntry(scriptPath)] });
    hooks[event] = withoutOurs;
  }

  return { settings, changed: JSON.stringify(settings) !== before };
}

/** Remove exactly our hook entries and prune any arrays/objects they leave empty. */
export function applyRemove(input: Json): { settings: Json; changed: boolean } {
  const before = JSON.stringify(input);
  const settings = clone(input);
  const hooks = settings.hooks as Record<string, HookGroup[]> | undefined;
  if (hooks && typeof hooks === "object") {
    for (const event of Object.keys(hooks)) {
      if (!Array.isArray(hooks[event])) continue;
      const kept = hooks[event].filter((g) => !isOurGroup(g));
      if (kept.length === 0) {
        delete hooks[event];
      } else {
        hooks[event] = kept;
      }
    }
    if (Object.keys(hooks).length === 0) {
      delete settings.hooks;
    }
  }
  return { settings, changed: JSON.stringify(settings) !== before };
}

/** True if every managed event already carries a correct entry pointing at scriptPath. */
export function isFullyInstalled(input: Json, scriptPath: string): boolean {
  const hooks = input.hooks as Record<string, HookGroup[]> | undefined;
  if (!hooks) return false;
  const want = path.basename(scriptPath.replace(/\\/g, "/"));
  return MANAGED_EVENTS.every((event) => {
    const arr = hooks[event];
    return (
      Array.isArray(arr) &&
      arr.some(
        (g) =>
          isOurGroup(g) &&
          g.hooks!.some((h) => basename((h.args ?? [])[0]) === want && (h.args ?? [])[0] === scriptPath),
      )
    );
  });
}

// ---- filesystem wrappers -------------------------------------------------

export interface FileOpResult {
  changed: boolean;
  path: string;
}

function parseSettings(raw: string, filePath: string): Json {
  const text = raw.trim();
  if (!text) return {};
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Cannot parse ${filePath} as JSON (${(e as Error).message}). Refusing to modify it. ` +
        `Fix or remove comments/trailing commas, then retry.`,
    );
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(`${filePath} is not a JSON object. Refusing to modify it.`);
  }
  return obj as Json;
}

function readSettings(filePath: string): Json {
  if (!fs.existsSync(filePath)) return {};
  return parseSettings(fs.readFileSync(filePath, "utf8"), filePath);
}

function writeSettings(filePath: string, settings: Json): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const backup = filePath + ".claude-toasts.bak";
  if (fs.existsSync(filePath) && !fs.existsSync(backup)) {
    fs.copyFileSync(filePath, backup);
  }
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

export function installHooksToFile(settingsPath: string, scriptPath: string): FileOpResult {
  const current = readSettings(settingsPath);
  const { settings, changed } = applyInstall(current, scriptPath);
  if (changed) writeSettings(settingsPath, settings);
  return { changed, path: settingsPath };
}

export function removeHooksFromFile(settingsPath: string): FileOpResult {
  if (!fs.existsSync(settingsPath)) return { changed: false, path: settingsPath };
  const current = readSettings(settingsPath);
  const { settings, changed } = applyRemove(current);
  if (changed) writeSettings(settingsPath, settings);
  return { changed, path: settingsPath };
}
