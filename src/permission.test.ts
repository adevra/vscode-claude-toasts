import { describe, expect, it } from "vitest";
import { evaluatePermissionRequest } from "./notificationPolicy";
import { MuteStore } from "./muteStore";
import { HookEvent, PolicyConfig, PolicyContext, ToastAction } from "./types";

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

function ctx(over: Partial<Omit<PolicyContext, "config">> = {}, cfg: Partial<PolicyConfig> = {}): PolicyContext {
  return {
    windowFocused: false,
    isBoundTerminalActive: false,
    folderName: "proj",
    ...over,
    config: { ...baseConfig, ...cfg },
  };
}

function ev(over: Partial<HookEvent> = {}): HookEvent {
  return {
    hook_event_name: "PermissionRequest",
    session_id: "s1",
    cwd: "C:/proj",
    ts: 1000,
    tool_name: "Bash",
    tool_summary: "rm -rf build",
    tool_use_id: "toolu_1",
    ...over,
  };
}

const actions = (): ToastAction[] => [
  { content: "Allow", uri: "vscode://x/permission?id=p1&decision=allow" },
  { content: "Deny", uri: "vscode://x/permission?id=p1&decision=deny" },
];

describe("evaluatePermissionRequest", () => {
  it("asks via a toast when the user is away, naming the tool and command", () => {
    const p = evaluatePermissionRequest(ev(), ctx(), actions);
    if (!("toast" in p)) throw new Error("expected a toast, got escalate: " + p.reason);
    expect(p.toast.kind).toBe("permission");
    expect(p.toast.title).toBe("Claude needs permission · proj");
    expect(p.toast.body).toBe("Bash: rm -rf build");
    expect(p.toast.sticky).toBe(true);
    expect(p.toast.urgency).toBe("high");
    expect(p.toast.actions?.map((a) => a.content)).toEqual(["Allow", "Deny"]);
  });

  it("escalates to the terminal when the user is watching it", () => {
    const p = evaluatePermissionRequest(ev(), ctx({ windowFocused: true, isBoundTerminalActive: true }), actions);
    expect("escalate" in p && p.reason).toMatch(/watching/);
  });

  it("escalates when muted", () => {
    const p = evaluatePermissionRequest(ev(), ctx({ muted: true }), actions);
    expect("escalate" in p && p.reason).toMatch(/muted/);
  });

  it("escalates when the extension is disabled", () => {
    const p = evaluatePermissionRequest(ev(), ctx({}, { enabled: false }), actions);
    expect("escalate" in p && p.reason).toMatch(/disabled/);
  });

  it("escalates when needs-input notifications are off", () => {
    const p = evaluatePermissionRequest(ev(), ctx({}, { notifyOnNeedsInput: false }), actions);
    expect("escalate" in p && p.reason).toMatch(/notifyOnNeedsInput/);
  });

  it("falls back to a generic body when there is no tool summary", () => {
    const p = evaluatePermissionRequest(ev({ tool_summary: null, tool_name: "Read" }), ctx(), actions);
    if (!("toast" in p)) throw new Error("expected a toast");
    expect(p.toast.body).toBe("Allow Read?");
  });

  it("keys dedup on the tool_use_id so back-to-back requests do not collapse", () => {
    const a = evaluatePermissionRequest(ev({ tool_use_id: "t1" }), ctx(), actions);
    const b = evaluatePermissionRequest(ev({ tool_use_id: "t2" }), ctx(), actions);
    if (!("toast" in a) || !("toast" in b)) throw new Error("expected toasts");
    expect(a.toast.dedupKey).not.toBe(b.toast.dedupKey);
  });

  it("truncates a very long command", () => {
    const p = evaluatePermissionRequest(ev({ tool_summary: "x".repeat(400) }), ctx(), actions);
    if (!("toast" in p)) throw new Error("expected a toast");
    expect(p.toast.body.length).toBeLessThanOrEqual("Bash: ".length + 120);
  });
});

describe("MuteStore", () => {
  it("mutes a single session without affecting others", () => {
    const m = new MuteStore();
    m.muteSession("s1", 1000);
    expect(m.isMuted("s1", 500)).toBe(true);
    expect(m.isMuted("s2", 500)).toBe(false);
  });

  it("expires a mute", () => {
    const m = new MuteStore();
    m.muteSession("s1", 1000);
    expect(m.isMuted("s1", 1001)).toBe(false);
  });

  it("mutes everything globally", () => {
    const m = new MuteStore();
    m.muteGlobal(1000);
    expect(m.isMuted("anything", 500)).toBe(true);
    expect(m.isMuted("anything", 1500)).toBe(false);
  });

  it("never shortens an existing mute", () => {
    const m = new MuteStore();
    m.muteSession("s1", 5000);
    m.muteSession("s1", 2000);
    expect(m.isMuted("s1", 4000)).toBe(true);
  });

  it("describes active mutes for diagnostics", () => {
    const m = new MuteStore();
    expect(m.describe(0)).toBe("nothing muted");
    m.muteGlobal(60_000);
    expect(m.describe(0)).toMatch(/all sessions/);
  });
});
