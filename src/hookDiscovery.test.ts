import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * These tests run the REAL hook.js out of a temp directory that mimics
 * globalStorage, so the hook resolves its live-window registry the same way it
 * does in production (relative to its own location).
 */

let tmpDirs: string[] = [];
let servers: net.Server[] = [];

afterEach(() => {
  for (const s of servers) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  servers = [];
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs = [];
});

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-home-"));
  tmpDirs.push(dir);
  fs.copyFileSync(path.resolve(__dirname, "../hook/hook.js"), path.join(dir, "claude-toasts-hook.js"));
  return dir;
}

let pipeSeq = 0;
function newPipePath(): string {
  pipeSeq += 1;
  const id = `${process.pid}-${Date.now()}-${pipeSeq}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\ct-test-${id}` : path.join(os.tmpdir(), `ct-${id}.sock`);
}

/** Start a listener that resolves with the first line it receives. */
function listen(pipePath: string): { path: string; first: Promise<string> } {
  let resolveFirst!: (v: string) => void;
  const first = new Promise<string>((r) => (resolveFirst = r));
  const server = net.createServer((socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (c: string) => {
      buf += c;
      const i = buf.indexOf("\n");
      if (i >= 0) resolveFirst(buf.slice(0, i));
    });
  });
  server.listen(pipePath);
  servers.push(server);
  return { path: pipePath, first };
}

function writeLiveEntry(home: string, entry: Record<string, unknown>): void {
  const dir = path.join(home, "live");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${Math.random().toString(16).slice(2)}.json`), JSON.stringify(entry));
}

function runHook(home: string, env: NodeJS.ProcessEnv, event: Record<string, unknown>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(home, "claude-toasts-hook.js")], {
      env: { ...process.env, CLAUDE_TOASTS_PIPE: "", CLAUDE_TOASTS_TOKEN: "", ...env },
    });
    child.on("close", (c) => resolve(c ?? -1));
    child.stdin.write(JSON.stringify(event));
    child.stdin.end();
  });
}

const STOP = { hook_event_name: "Stop", session_id: "s1", cwd: "C:/work/proj", last_assistant_message: "done" };

describe("hook.js live-window discovery", () => {
  it("falls back to the live registry when the env pipe is dead (the reload bug)", async () => {
    const home = makeHome();
    const live = listen(newPipePath());
    writeLiveEntry(home, { pipe: live.path, token: "livetok", pid: process.pid, folders: ["C:/work/proj"] });

    // Env points at a pipe that was never created — exactly what a stale terminal has.
    const code = await runHook(
      home,
      { CLAUDE_TOASTS_PIPE: newPipePath(), CLAUDE_TOASTS_TOKEN: "deadtok" },
      STOP,
    );

    const line = await live.first;
    expect(code).toBe(0);
    expect(JSON.parse(line).t).toBe("livetok");
    expect(JSON.parse(line).hook_event_name).toBe("Stop");
  });

  it("works with no env vars at all (terminal opened before activation)", async () => {
    const home = makeHome();
    const live = listen(newPipePath());
    writeLiveEntry(home, { pipe: live.path, token: "tok2", pid: process.pid, folders: ["C:/work/proj"] });

    const code = await runHook(home, {}, STOP);
    const line = await live.first;
    expect(code).toBe(0);
    expect(JSON.parse(line).t).toBe("tok2");
  });

  it("prefers the window whose folder contains the session cwd", async () => {
    const home = makeHome();
    const wrong = listen(newPipePath());
    const right = listen(newPipePath());
    writeLiveEntry(home, { pipe: wrong.path, token: "wrong", pid: process.pid, folders: ["C:/other"] });
    writeLiveEntry(home, { pipe: right.path, token: "right", pid: process.pid, folders: ["C:/work/proj"] });

    await runHook(home, {}, STOP);
    const line = await right.first;
    expect(JSON.parse(line).t).toBe("right");
  });

  it("uses the env pipe when it is alive, without consulting the registry", async () => {
    const home = makeHome();
    const envPipe = listen(newPipePath());
    const registryPipe = listen(newPipePath());
    writeLiveEntry(home, { pipe: registryPipe.path, token: "registry", pid: process.pid, folders: ["C:/work/proj"] });

    await runHook(home, { CLAUDE_TOASTS_PIPE: envPipe.path, CLAUDE_TOASTS_TOKEN: "envtok" }, STOP);
    const line = await envPipe.first;
    expect(JSON.parse(line).t).toBe("envtok");
  });

  it("exits 0 quietly when nothing is reachable", async () => {
    const home = makeHome();
    writeLiveEntry(home, { pipe: newPipePath(), token: "dead", pid: process.pid, folders: ["C:/work/proj"] });
    const code = await runHook(home, { CLAUDE_TOASTS_PIPE: newPipePath(), CLAUDE_TOASTS_TOKEN: "x" }, STOP);
    expect(code).toBe(0);
  });
});
