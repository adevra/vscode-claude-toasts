import {
  BLOCKING_NOTIFICATION_TYPES,
  Decision,
  HookEvent,
  MAX_MESSAGE_CHARS,
  PolicyConfig,
  PolicyContext,
  PolicyResult,
} from "./types";

function suppressed(reason: string): PolicyResult {
  return { suppressed: true, reason };
}

function isUserWatching(ctx: PolicyContext): boolean {
  return (
    ctx.config.suppressWhenActiveTerminal &&
    ctx.windowFocused &&
    ctx.isBoundTerminalActive
  );
}

/** Collapse whitespace and clip to `max` chars (never above MAX_MESSAGE_CHARS). */
export function preview(text: string | null | undefined, max: number): string {
  if (!text) {
    return "";
  }
  const limit = Math.max(0, Math.min(max, MAX_MESSAGE_CHARS));
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) {
    return collapsed;
  }
  return collapsed.slice(0, Math.max(0, limit - 1)).trimEnd() + "…";
}

function describeNeedsInput(
  notificationType: string | null | undefined,
  toolName: string | null | undefined,
): string {
  switch (notificationType) {
    case "permission_prompt":
      return toolName ? `Permission needed to run ${toolName}` : "Permission needed";
    case "idle_prompt":
      return "Waiting for your input";
    case "agent_needs_input":
      return "Claude needs your input";
    default:
      return "Claude needs your input";
  }
}

function decision(
  kind: Decision["kind"],
  title: string,
  body: string,
  urgency: Decision["urgency"],
  sticky: boolean,
  sessionId: string,
): PolicyResult {
  return {
    decision: { kind, title, body, urgency, sticky, sessionId, dedupKey: `${sessionId}:${kind}` },
  };
}

/**
 * Pure decision: given one slimmed hook event and the surrounding context, decide
 * whether to show a toast and what it should say. Stateless — dedup and the rate
 * cap live in ToastGate below.
 */
export function evaluateEvent(event: HookEvent, ctx: PolicyContext): PolicyResult {
  const cfg = ctx.config;
  const sessionId = event.session_id ?? "unknown";

  if (!cfg.enabled) {
    return suppressed("extension disabled");
  }

  switch (event.hook_event_name) {
    case "Stop": {
      if (!cfg.notifyOnComplete) {
        return suppressed("notifyOnComplete is off");
      }
      if (ctx.turnStartedAt != null) {
        const elapsedSec = (event.ts - ctx.turnStartedAt) / 1000;
        if (elapsedSec < cfg.minTurnDurationSeconds) {
          return suppressed(
            `turn too short (${elapsedSec.toFixed(1)}s < ${cfg.minTurnDurationSeconds}s)`,
          );
        }
      }
      if (isUserWatching(ctx)) {
        return suppressed("user is watching the session terminal");
      }
      const body = preview(event.last_assistant_message, cfg.messagePreviewLength);
      return decision("complete", `Claude finished · ${ctx.folderName}`, body, "normal", false, sessionId);
    }

    case "Notification": {
      if (!cfg.notifyOnNeedsInput) {
        return suppressed("notifyOnNeedsInput is off");
      }
      const nt = event.notification_type ?? null;
      if (!BLOCKING_NOTIFICATION_TYPES.includes(nt as never)) {
        return suppressed(`ignored notification_type: ${nt ?? "none"}`);
      }
      if (isUserWatching(ctx)) {
        return suppressed("user is watching the session terminal");
      }
      const body = describeNeedsInput(nt, event.tool_name);
      return decision("needs-input", `Claude needs you · ${ctx.folderName}`, body, "high", true, sessionId);
    }

    default:
      return suppressed(`no toast for ${event.hook_event_name ?? "unknown"} event`);
  }
}

export type GateResult = { ok: true } | { ok: false; reason: string };

/**
 * Stateful gate applied after evaluateEvent: dedup (collapse the same session+kind
 * within a window) and a global per-minute rate cap (runaway backstop).
 */
export class ToastGate {
  private lastByKey = new Map<string, number>();
  private emitTimes: number[] = [];

  constructor(private cfg: Pick<PolicyConfig, "dedupWindowSeconds" | "maxToastsPerMinute">) {}

  update(cfg: Pick<PolicyConfig, "dedupWindowSeconds" | "maxToastsPerMinute">): void {
    this.cfg = cfg;
  }

  admit(dedupKey: string, now: number): GateResult {
    const last = this.lastByKey.get(dedupKey);
    if (last != null && now - last < this.cfg.dedupWindowSeconds * 1000) {
      return { ok: false, reason: `deduped (within ${this.cfg.dedupWindowSeconds}s)` };
    }

    const cutoff = now - 60_000;
    this.emitTimes = this.emitTimes.filter((t) => t > cutoff);
    if (this.emitTimes.length >= this.cfg.maxToastsPerMinute) {
      return { ok: false, reason: `rate cap (${this.cfg.maxToastsPerMinute}/min)` };
    }

    this.lastByKey.set(dedupKey, now);
    this.emitTimes.push(now);
    return { ok: true };
  }
}
