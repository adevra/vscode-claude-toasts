import {
  BLOCKING_NOTIFICATION_TYPES,
  Decision,
  HookEvent,
  MAX_MESSAGE_CHARS,
  PolicyConfig,
  PolicyContext,
  PolicyResult,
  ToastAction,
} from "./types";

function suppressed(reason: string): PolicyResult {
  return { suppressed: true, reason };
}

/** True when the person is demonstrably at this terminal right now. */
export function isUserWatching(ctx: PolicyContext): boolean {
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

/** Like preview, but keeps the END of the text - where a reply's conclusions live. */
export function previewTail(text: string | null | undefined, max: number): string {
  if (!text) {
    return "";
  }
  const limit = Math.max(0, Math.min(max, MAX_MESSAGE_CHARS));
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) {
    return collapsed;
  }
  return "…" + collapsed.slice(-(limit - 1)).trimStart();
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
  ctx: PolicyContext,
): PolicyResult {
  return {
    decision: {
      kind,
      title,
      body,
      urgency,
      sticky,
      sessionId,
      dedupKey: `${sessionId}:${kind}`,
      attribution: ctx.attribution,
      accentColor: ctx.accentColor ?? null,
    },
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
  if (ctx.muted) {
    return suppressed("muted");
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
      const body = previewTail(event.last_assistant_message, cfg.messagePreviewLength);
      return decision("complete", `Claude finished · ${ctx.folderName}`, body, "normal", false, sessionId, ctx);
    }

    case "Notification": {
      if (!cfg.notifyOnNeedsInput) {
        return suppressed("notifyOnNeedsInput is off");
      }
      const nt = event.notification_type ?? null;
      if (!BLOCKING_NOTIFICATION_TYPES.includes(nt as never)) {
        return suppressed(`ignored notification_type: ${nt ?? "none"}`);
      }
      if (nt === "idle_prompt" && ctx.completedToastShownThisTurn) {
        return suppressed("already notified that this turn finished");
      }
      if (isUserWatching(ctx)) {
        return suppressed("user is watching the session terminal");
      }
      const body = describeNeedsInput(nt, event.tool_name);
      return decision("needs-input", `Claude needs you · ${ctx.folderName}`, body, "high", true, sessionId, ctx);
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

/**
 * Plan for a PermissionRequest. Unlike other events this MUST produce an answer,
 * because the hook is blocking Claude while it waits.
 *
 * "escalate" means: hand control back to Claude Code's own terminal prompt. That
 * is the safe default for every case where a desktop toast would be wrong or
 * useless — the person is already looking at the terminal, notifications are off,
 * or the session is muted.
 */
export type PermissionPlan =
  | { escalate: true; reason: string }
  | { toast: Decision };

export function evaluatePermissionRequest(
  event: HookEvent,
  ctx: PolicyContext,
  actions: (sessionId: string) => ToastAction[],
): PermissionPlan {
  const cfg = ctx.config;
  if (!cfg.enabled) {
    return { escalate: true, reason: "extension disabled" };
  }
  if (!cfg.notifyOnNeedsInput) {
    return { escalate: true, reason: "notifyOnNeedsInput is off" };
  }
  if (ctx.muted) {
    return { escalate: true, reason: "muted" };
  }
  if (isUserWatching(ctx)) {
    return { escalate: true, reason: "user is watching the session terminal" };
  }

  const sessionId = event.session_id ?? "unknown";
  const tool = event.tool_name ?? "a tool";
  const summary = preview(event.tool_summary, cfg.messagePreviewLength);
  return {
    toast: {
      kind: "permission",
      title: `Claude needs permission · ${ctx.folderName}`,
      body: summary ? `${tool}: ${summary}` : `Allow ${tool}?`,
      urgency: "high",
      sticky: true,
      sessionId,
      dedupKey: `${sessionId}:permission:${event.tool_use_id ?? ""}`,
      actions: actions(sessionId),
      attribution: ctx.attribution,
      accentColor: ctx.accentColor ?? null,
    },
  };
}
