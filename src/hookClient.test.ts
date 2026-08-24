import { spawn } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = path.resolve(__dirname, "../hook/hook.js");

interface Harness {
  pipePath: string;
  received: Promise<string[]>;
  close(): void;
}

function pipeServer(): Harness {
  const id = Math.abs(hash(process.pid + ":" + Date.now() + ":" + Math.random()));
  const pipePath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\claude-toasts-test-${id}`
      : `/tmp/claude-toasts-test-${id}.sock`;
  const lines: string[] = [];
  let resolveLines!: (v: string[]) => void;
  const received = new Promise<string[]>((r) => (resolveLines = r));

  const server = net.createServer((socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    socket.on("close", () => resolveLines(lines));
  });
  server.listen(pipePath);
  return { pipePath, received, close: () => server.close() };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function runHook(env: NodeJS.ProcessEnv, stdin: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, ...env } });
    child.on("close", (code) => resolve(code ?? -1));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

let harness: Harness | undefined;
afterEach(() => harness?.close());

describe("hook.js", () => {
  it("forwards a slimmed, token-stamped payload over the pipe", async () => {
    harness = pipeServer();
    const code = await runHook(
      { CLAUDE_TOASTS_PIPE: harness.pipePath, CLAUDE_TOASTS_TOKEN: "tok123" },
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: "sess-1",
        cwd: "C:/proj",
        last_assistant_message: "Finished the task.",
        transcript_path: "/should/be/dropped",
        extra: "dropped too",
      }),
    );
    expect(code).toBe(0);
    const lines = await harness.received;
    expect(lines).toHaveLength(1);
    const p = JSON.parse(lines[0]);
    expect(p.t).toBe("tok123");
    expect(p.hook_event_name).toBe("Stop");
    expect(p.session_id).toBe("sess-1");
    expect(p.last_assistant_message).toBe("Finished the task.");
    expect(p.transcript_path).toBeUndefined();
    expect(p.extra).toBeUndefined();
    expect(typeof p.ts).toBe("number");
  });

  it("truncates the assistant message to 500 chars", async () => {
    harness = pipeServer();
    await runHook(
      { CLAUDE_TOASTS_PIPE: harness.pipePath, CLAUDE_TOASTS_TOKEN: "t" },
      JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "x".repeat(2000) }),
    );
    const lines = await harness.received;
    expect(JSON.parse(lines[0]).last_assistant_message.length).toBe(500);
  });

  it("exits 0 and sends nothing when the env vars are absent", async () => {
    const code = await runHook({ CLAUDE_TOASTS_PIPE: "", CLAUDE_TOASTS_TOKEN: "" }, "{}");
    expect(code).toBe(0);
  });

  it("exits 0 on unparseable stdin", async () => {
    harness = pipeServer();
    const code = await runHook(
      { CLAUDE_TOASTS_PIPE: harness.pipePath, CLAUDE_TOASTS_TOKEN: "t" },
      "not json at all",
    );
    expect(code).toBe(0);
  });
});
