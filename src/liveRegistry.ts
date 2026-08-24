import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The live-window registry: one JSON file per active VS Code window, written
 * next to the hook script in globalStorage.
 *
 * This is what lets a terminal keep working after the extension host reloads.
 * The terminal's injected pipe address goes stale on every extension update, but
 * the registry is read fresh by the hook at event time, so it always reflects
 * the windows that are listening right now.
 */
export interface LiveEntry {
  pipe: string;
  token: string;
  pid: number;
  folders: string[];
  updatedAt: number;
}

export function registryDir(globalStorageDir: string): string {
  return path.join(globalStorageDir, "live");
}

/** Write this window's entry and return the file path. */
export function writeLiveEntry(globalStorageDir: string, entry: Omit<LiveEntry, "updatedAt">): string {
  const dir = registryDir(globalStorageDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${randomBytes(6).toString("hex")}.json`);
  const payload: LiveEntry = { ...entry, updatedAt: Date.now() };
  fs.writeFileSync(file, JSON.stringify(payload), "utf8");
  return file;
}

export function removeLiveEntry(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/**
 * Delete entries whose owning process is no longer alive. Windows that crash or
 * are killed cannot clean up after themselves, so do it opportunistically at
 * activation. Returns the number of files removed.
 */
export function pruneDeadEntries(globalStorageDir: string, selfPid: number): number {
  const dir = registryDir(globalStorageDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const entry = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LiveEntry>;
      const pid = typeof entry.pid === "number" ? entry.pid : 0;
      if (!pid || pid === selfPid || isAlive(pid)) continue;
      fs.unlinkSync(file);
      removed += 1;
    } catch {
      // Unreadable or malformed: drop it, it can never route anything.
      try {
        fs.unlinkSync(file);
        removed += 1;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
