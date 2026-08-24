import { describe, expect, it } from "vitest";
import { evaluateEvent, preview, ToastGate } from "./notificationPolicy";
import { HookEvent, PolicyConfig, PolicyContext } from "./types";

const baseConfig: PolicyConfig = {
  enabled: true,
  notifyOnComplete: true,
  notifyOnNeedsInput: true,
  minTurnDurationSeconds: 20,
  suppressWhenActiveTerminal: true,
  messagePreviewLength: 120,
  dedupWindowSeconds: 5,
  maxToastsPerMinute: 10,
};

function ctx(
  over: Partial<Omit<PolicyContext, "config">> = {},
  configOver: Partial<PolicyConfig> = {},
): PolicyContext {
  return {
    windowFocused: false,
    isBoundTerminalActive: false,
    turnStartedAt: undefined,
    folderName: "proj",
    ...over,
    config: { ...baseConfig, ...configOver },
  };
}

function ev(over: Partial<HookEvent> = {}): HookEvent {
  return {
    hook_event_name: "Stop",
    session_id: "s1",
    cwd: "C:/proj",
    ts: 100_000,
    ...over,
  };
}

function reason(r: ReturnType<typeof evaluateEvent>): string | null {
  return "suppressed" in r ? r.reason : null;
}

describe("evaluateEvent — Stop", () => {
  it("fires a completion toast for a long turn", () => {
    const r = evaluateEvent(ev({ ts: 100_000, last_assistant_message: "All done." }), ctx({ turnStartedAt: 50_000 }));
    if (!("decision" in r)) throw new Error("expected a decision, got " + reason(r));
    expect(r.decision.kind).toBe("complete");
    expect(r.decision.title).toBe("Claude finished · proj");
    expect(r.decision.body).toBe("All done.");
    expect(r.decision.urgency).toBe("normal");
    expect(r.decision.sticky).toBe(false);
    expect(r.decision.dedupKey).toBe("s1:complete");
  });

  it("suppresses turns shorter than the minimum", () => {
    const r = evaluateEvent(ev({ ts: 105_000 }), ctx({ turnStartedAt: 100_000 })); // 5s
    expect(reason(r)).toMatch(/too short/);
  });

  it("fires exactly at the duration boundary", () => {
    const r = evaluateEvent(ev({ ts: 120_000 }), ctx({ turnStartedAt: 100_000 })); // 20s
    expect("decision" in r).toBe(true);
  });

  it("fires when the turn start is unknown (no gate to apply)", () => {
    const r = evaluateEvent(ev({ ts: 100_000 }), ctx({ turnStartedAt: undefined }));
    expect("decision" in r).toBe(true);
  });

  it("suppresses when the user is watching the bound terminal", () => {
    const r = evaluateEvent(ev(), ctx({ windowFocused: true, isBoundTerminalActive: true }));
    expect(reason(r)).toMatch(/watching/);
  });

  it("still fires if watching but suppressWhenActiveTerminal is off", () => {
    const r = evaluateEvent(
      ev(),
      ctx({ windowFocused: true, isBoundTerminalActive: true }, { suppressWhenActiveTerminal: false }),
    );
    expect("decision" in r).toBe(true);
  });

  it("fires when focused but looking at a different terminal", () => {
    const r = evaluateEvent(ev(), ctx({ windowFocused: true, isBoundTerminalActive: false }));
    expect("decision" in r).toBe(true);
  });

  it("respects the notifyOnComplete toggle", () => {
    const r = evaluateEvent(ev(), ctx({}, { notifyOnComplete: false }));
    expect(reason(r)).toMatch(/notifyOnComplete/);
  });
});

describe("evaluateEvent — Notification", () => {
  for (const nt of ["permission_prompt", "idle_prompt", "agent_needs_input"]) {
    it(`fires a high-urgency sticky toast for ${nt}`, () => {
      const r = evaluateEvent(ev({ hook_event_name: "Notification", notification_type: nt }), ctx());
      if (!("decision" in r)) throw new Error("expected a decision, got " + reason(r));
      expect(r.decision.kind).toBe("needs-input");
      expect(r.decision.urgency).toBe("high");
      expect(r.decision.sticky).toBe(true);
      expect(r.decision.title).toBe("Claude needs you · proj");
    });
  }

  it("names the tool for a permission prompt", () => {
    const r = evaluateEvent(
      ev({ hook_event_name: "Notification", notification_type: "permission_prompt", tool_name: "Bash" }),
      ctx(),
    );
    if (!("decision" in r)) throw new Error("expected a decision");
    expect(r.decision.body).toBe("Permission needed to run Bash");
  });

  it("ignores non-blocking notification types", () => {
    const r = evaluateEvent(ev({ hook_event_name: "Notification", notification_type: "auth_success" }), ctx());
    expect(reason(r)).toMatch(/ignored notification_type/);
  });

  it("has no duration gate — fires even for an instant block", () => {
    const r = evaluateEvent(
      ev({ hook_event_name: "Notification", notification_type: "idle_prompt", ts: 100_100 }),
      ctx({ turnStartedAt: 100_000 }), // 0.1s
    );
    expect("decision" in r).toBe(true);
  });

  it("suppresses the idle nag when we already toasted this turn's completion", () => {
    const r = evaluateEvent(
      ev({ hook_event_name: "Notification", notification_type: "idle_prompt" }),
      ctx({ completedToastShownThisTurn: true }),
    );
    expect(reason(r)).toMatch(/already notified/);
  });

  it("still fires idle when the completion toast was suppressed", () => {
    const r = evaluateEvent(
      ev({ hook_event_name: "Notification", notification_type: "idle_prompt" }),
      ctx({ completedToastShownThisTurn: false }),
    );
    expect("decision" in r).toBe(true);
  });

  it("does not let a completed turn mute a permission prompt", () => {
    const r = evaluateEvent(
      ev({ hook_event_name: "Notification", notification_type: "permission_prompt" }),
      ctx({ completedToastShownThisTurn: true }),
    );
    expect("decision" in r).toBe(true);
  });

  it("respects the notifyOnNeedsInput toggle", () => {
    const r = evaluateEvent(
      ev({ hook_event_name: "Notification", notification_type: "idle_prompt" }),
      ctx({}, { notifyOnNeedsInput: false }),
    );
    expect(reason(r)).toMatch(/notifyOnNeedsInput/);
  });
});

describe("evaluateEvent — misc", () => {
  it("suppresses everything when disabled", () => {
    const r = evaluateEvent(ev(), ctx({}, { enabled: false }));
    expect(reason(r)).toMatch(/disabled/);
  });

  it("produces no toast for bookkeeping events", () => {
    for (const name of ["SessionStart", "UserPromptSubmit", "SessionEnd"]) {
      const r = evaluateEvent(ev({ hook_event_name: name }), ctx());
      expect(reason(r)).toMatch(/no toast/);
    }
  });
});

describe("preview", () => {
  it("collapses whitespace", () => {
    expect(preview("hello\n\n  world", 100)).toBe("hello world");
  });
  it("truncates with an ellipsis", () => {
    expect(preview("abcdefghij", 5)).toBe("abcd…");
  });
  it("never exceeds MAX_MESSAGE_CHARS even if asked", () => {
    const long = "x".repeat(1000);
    expect(preview(long, 9999).length).toBe(500);
  });
  it("handles null", () => {
    expect(preview(null, 100)).toBe("");
  });
});

describe("ToastGate", () => {
  it("dedups within the window and admits after it", () => {
    const g = new ToastGate({ dedupWindowSeconds: 5, maxToastsPerMinute: 100 });
    expect(g.admit("s1:complete", 0).ok).toBe(true);
    expect(g.admit("s1:complete", 4000).ok).toBe(false);
    expect(g.admit("s1:complete", 6000).ok).toBe(true);
  });

  it("does not dedup across different keys", () => {
    const g = new ToastGate({ dedupWindowSeconds: 5, maxToastsPerMinute: 100 });
    expect(g.admit("s1:complete", 0).ok).toBe(true);
    expect(g.admit("s1:needs-input", 0).ok).toBe(true);
  });

  it("enforces the per-minute rate cap and recovers", () => {
    const g = new ToastGate({ dedupWindowSeconds: 0, maxToastsPerMinute: 3 });
    expect(g.admit("k", 0).ok).toBe(true);
    expect(g.admit("k", 1).ok).toBe(true);
    expect(g.admit("k", 2).ok).toBe(true);
    const capped = g.admit("k", 3);
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.reason).toMatch(/rate cap/);
    // after the oldest falls out of the 60s window
    expect(g.admit("k", 60_001).ok).toBe(true);
  });
});
