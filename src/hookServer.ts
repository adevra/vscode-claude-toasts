import { randomBytes } from "node:crypto";
import * as net from "node:net";
import { HookEvent } from "./types";

const MAX_LINE_BYTES = 64 * 1024;

export interface HookServerHandle {
  /** Full pipe path to inject into terminals (e.g. \\.\pipe\claude-toasts-abcd). */
  pipePath: string;
  /** Shared secret the hook must echo back; lines with a wrong token are dropped. */
  token: string;
  dispose(): void;
}

export interface HookServerCallbacks {
  onEvent(event: HookEvent): void;
  /** Diagnostics: dropped lines, parse errors, etc. */
  onLog(message: string): void;
}

/**
 * Per-window named-pipe listener. Each connection may carry one or more
 * newline-delimited JSON payloads from hook.js. Lines whose token does not match
 * are dropped; oversized lines are truncated and dropped.
 */
export function startHookServer(cb: HookServerCallbacks): HookServerHandle {
  const id = randomBytes(8).toString("hex");
  const token = randomBytes(16).toString("hex");
  const pipePath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\claude-toasts-${id}`
      : `/tmp/claude-toasts-${id}.sock`;

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES * 4) {
        buffer = buffer.slice(-MAX_LINE_BYTES);
      }
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line, token, cb);
      }
    });
    socket.on("error", () => {
      /* client vanished; ignore */
    });
  });

  server.on("error", (err) => cb.onLog(`pipe server error: ${err.message}`));
  server.listen(pipePath, () => cb.onLog(`listening on ${pipePath}`));

  return {
    pipePath,
    token,
    dispose() {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    },
  };
}

function handleLine(line: string, token: string, cb: HookServerCallbacks): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed.length > MAX_LINE_BYTES) {
    cb.onLog("dropped oversized line");
    return;
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    cb.onLog("dropped unparseable line");
    return;
  }
  if (obj.t !== token) {
    cb.onLog("dropped line with bad token");
    return;
  }
  cb.onEvent({
    hook_event_name: str(obj.hook_event_name),
    session_id: str(obj.session_id),
    cwd: str(obj.cwd),
    ts: typeof obj.ts === "number" ? obj.ts : Date.now(),
    notification_type: str(obj.notification_type),
    tool_name: str(obj.tool_name),
    last_assistant_message: str(obj.last_assistant_message),
  });
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
