import { spawn } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { startHookServer } from "./hookServer";

const HOOK = path.resolve(__dirname, "../hook/hook.js");

/** Run the real hook and capture what it prints for Claude Code to read. */
function runHook(
  pipe: string,
  token: string,
  event: Record<string, unknown>,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, CLAUDE_TOASTS_PIPE: pipe, CLAUDE_TOASTS_TOKEN: token },
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
    child.stdin.write(JSON.stringify(event));
    child.stdin.end();
  });
}

const PERMISSION_EVENT = {
  hook_event_name: "PermissionRequest",
  session_id: "s1",
  cwd: "C:/proj",
  tool_name: "Bash",
  tool_use_id: "toolu_1",
  tool_input: { command: "rm -rf build", description: "clean" },
};

describe("PermissionRequest round trip", () => {
  it("carries the decision back to Claude Code on stdout", async () => {
    const server = startHookServer({
      onLog: () => {},
      onEvent: (ev, respond) => {
        expect(ev.hook_event_name).toBe("PermissionRequest");
        expect(ev.tool_summary).toBe("rm -rf build");
        expect(ev.tool_use_id).toBe("toolu_1");
        respond({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            permissionDecision: "allow",
            permissionDecisionReason: "Approved from a desktop notification",
          },
        });
      },
    });

    const { code, stdout } = await runHook(server.pipePath, server.token, PERMISSION_EVENT);
    server.dispose();

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
  });

  it("passes deny through unchanged", async () => {
    const server = startHookServer({
      onLog: () => {},
      onEvent: (_ev, respond) =>
        respond({ hookSpecificOutput: { hookEventName: "PermissionRequest", permissionDecision: "deny" } }),
    });
    const { stdout } = await runHook(server.pipePath, server.token, PERMISSION_EVENT);
    server.dispose();
    expect(JSON.parse(stdout.trim()).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("prints nothing when the extension closes without answering (falls through to the terminal prompt)", async () => {
    const server = startHookServer({ onLog: () => {}, onEvent: () => {} });
    const p = runHook(server.pipePath, server.token, PERMISSION_EVENT);
    // Drop the server; the hook should give up quietly rather than hang.
    setTimeout(() => server.dispose(), 150);
    const { code, stdout } = await p;
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  it("does not wait for a response on fire-and-forget events", async () => {
    const server = startHookServer({ onLog: () => {}, onEvent: () => {} });
    const started = Date.now();
    const { code, stdout } = await runHook(server.pipePath, server.token, {
      hook_event_name: "Stop",
      session_id: "s1",
      cwd: "C:/proj",
      last_assistant_message: "done",
    });
    server.dispose();
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
