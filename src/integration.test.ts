import { spawn } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { startHookServer } from "./hookServer";
import { evaluateEvent, ToastGate } from "./notificationPolicy";
import { HookEvent, PolicyConfig } from "./types";

const HOOK = path.resolve(__dirname, "../hook/hook.js");

const cfg: PolicyConfig = {
  enabled: true,
  notifyOnComplete: true,
  notifyOnNeedsInput: true,
  minTurnDurationSeconds: 20,
  suppressWhenActiveTerminal: true,
  messagePreviewLength: 120,
  dedupWindowSeconds: 5,
  maxToastsPerMinute: 10,
};

/** Fire a hook event through the real hook client into the real pipe server. */
function fireHook(pipePath: string, token: string, event: Partial<HookEvent> & { hook_event_name: string }): void {
  const child = spawn(process.execPath, [HOOK], {
    env: { ...process.env, CLAUDE_TOASTS_PIPE: pipePath, CLAUDE_TOASTS_TOKEN: token },
  });
  child.stdin.write(JSON.stringify(event));
  child.stdin.end();
}

describe("integration: hook.js -> pipe -> policy -> notifier", () => {
  it("delivers a completion toast end to end", async () => {
    const shown: { title: string; body: string }[] = [];
    const gate = new ToastGate(cfg);

    const done = new Promise<void>((resolve) => {
      const server = startHookServer({
        onLog: () => {},
        onEvent: (ev) => {
          // Mirror extension.ts glue for a Stop event (turn start unknown => no gate).
          const result = evaluateEvent(ev, {
            windowFocused: false,
            isBoundTerminalActive: false,
            turnStartedAt: undefined,
            folderName: "proj",
            config: cfg,
          });
          if ("decision" in result && gate.admit(result.decision.dedupKey, Date.now()).ok) {
            shown.push({ title: result.decision.title, body: result.decision.body });
            server.dispose();
            resolve();
          }
        },
      });
      fireHook(server.pipePath, server.token, {
        hook_event_name: "Stop",
        session_id: "s1",
        cwd: "C:/proj",
        last_assistant_message: "Migration complete.",
      });
    });

    await done;
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe("Claude finished · proj");
    expect(shown[0].body).toBe("Migration complete.");
  });

  it("drops a spoofed event with the wrong token", async () => {
    let events = 0;
    const server = startHookServer({ onLog: () => {}, onEvent: () => (events += 1) });
    // Wrong token: hook stamps 'badtoken', server expects server.token.
    fireHook(server.pipePath, "badtoken", { hook_event_name: "Stop", session_id: "x" });
    await new Promise((r) => setTimeout(r, 400));
    server.dispose();
    expect(events).toBe(0);
  });
});
