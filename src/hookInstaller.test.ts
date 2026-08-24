import { describe, expect, it } from "vitest";
import { applyInstall, applyRemove, isFullyInstalled, MANAGED_EVENTS } from "./hookInstaller";

const SCRIPT = "C:\\Users\\me\\AppData\\Roaming\\Code\\globalStorage\\adev.vscode-claude-toasts\\claude-toasts-hook.js";

function ourGroups(settings: Record<string, unknown>, event: string): unknown[] {
  const hooks = settings.hooks as Record<string, unknown[]>;
  return (hooks[event] as { hooks?: { args?: unknown[] }[] }[]).filter((g) =>
    (g.hooks ?? []).some((h) => String((h.args ?? [])[0]).endsWith("claude-toasts-hook.js")),
  );
}

describe("applyInstall", () => {
  it("adds one entry to every managed event on an empty file", () => {
    const { settings, changed } = applyInstall({}, SCRIPT);
    expect(changed).toBe(true);
    for (const event of MANAGED_EVENTS) {
      expect(ourGroups(settings, event)).toHaveLength(1);
    }
    expect(isFullyInstalled(settings, SCRIPT)).toBe(true);
  });

  it("preserves unrelated user hooks on the same event", () => {
    const user = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
      },
    };
    const { settings } = applyInstall(user, SCRIPT);
    const stop = (settings.hooks as Record<string, unknown[]>).Stop;
    expect(stop).toHaveLength(2); // user's echo + ours
    expect(JSON.stringify(settings)).toContain("echo hi");
    expect(JSON.stringify(settings)).toContain("guard.sh");
  });

  it("is idempotent — installing twice yields one entry per event", () => {
    const once = applyInstall({}, SCRIPT).settings;
    const twice = applyInstall(once, SCRIPT);
    expect(twice.changed).toBe(false);
    for (const event of MANAGED_EVENTS) {
      expect(ourGroups(twice.settings, event)).toHaveLength(1);
    }
  });

  it("heals a stale script path", () => {
    const stale = applyInstall({}, "C:\\old\\path\\claude-toasts-hook.js").settings;
    const fixed = applyInstall(stale, SCRIPT);
    expect(fixed.changed).toBe(true);
    expect(isFullyInstalled(fixed.settings, SCRIPT)).toBe(true);
    expect(JSON.stringify(fixed.settings)).not.toContain("old\\\\path");
    for (const event of MANAGED_EVENTS) {
      expect(ourGroups(fixed.settings, event)).toHaveLength(1);
    }
  });
});

describe("applyRemove", () => {
  it("round-trips an empty file to identical", () => {
    const installed = applyInstall({}, SCRIPT).settings;
    const { settings, changed } = applyRemove(installed);
    expect(changed).toBe(true);
    expect(settings).toEqual({});
  });

  it("removes only our entries and keeps user hooks", () => {
    const user = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } };
    const installed = applyInstall(user, SCRIPT).settings;
    const { settings } = applyRemove(installed);
    expect(settings).toEqual(user);
  });

  it("prunes emptied event arrays and the hooks object", () => {
    const installed = applyInstall({}, SCRIPT).settings;
    const { settings } = applyRemove(installed);
    expect(settings.hooks).toBeUndefined();
  });

  it("is a no-op when nothing is ours", () => {
    const user = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } };
    const { changed } = applyRemove(user);
    expect(changed).toBe(false);
  });
});

describe("install then remove round-trip", () => {
  it("returns the original object for a file with pre-existing hooks", () => {
    const original = {
      model: "opus",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
        Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }],
      },
    };
    const installed = applyInstall(original, SCRIPT).settings;
    const removed = applyRemove(installed).settings;
    expect(removed).toEqual(original);
  });
});
