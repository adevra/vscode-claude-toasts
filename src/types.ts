/** Shared types for the extension. No `vscode` imports here so this file stays testable. */

/** A hook event after it has been slimmed by hook.js and parsed off the pipe. */
export interface HookEvent {
  hook_event_name: string | null;
  session_id: string | null;
  cwd: string | null;
  ts: number;
  notification_type?: string | null;
  tool_name?: string | null;
  last_assistant_message?: string | null;
}

export type ToastKind = "complete" | "needs-input";
export type Urgency = "normal" | "high";

/** A resolved intent to show one toast. Platform-agnostic. */
export interface Decision {
  kind: ToastKind;
  title: string;
  body: string;
  urgency: Urgency;
  sticky: boolean;
  sessionId: string;
  /** Collapses repeats: same session + kind share a key. */
  dedupKey: string;
}

export type PolicyResult =
  | { decision: Decision }
  | { suppressed: true; reason: string };

export interface PolicyConfig {
  enabled: boolean;
  notifyOnComplete: boolean;
  notifyOnNeedsInput: boolean;
  minTurnDurationSeconds: number;
  suppressWhenActiveTerminal: boolean;
  messagePreviewLength: number;
  dedupWindowSeconds: number;
  maxToastsPerMinute: number;
}

export interface PolicyContext {
  /** Is this VS Code window in the OS foreground? */
  windowFocused: boolean;
  /** Is the terminal bound to this session the currently active one? */
  isBoundTerminalActive: boolean;
  /** When the current turn started (ms epoch), from UserPromptSubmit; undefined if unknown. */
  turnStartedAt?: number;
  /** Short folder name for the toast title. */
  folderName: string;
  config: PolicyConfig;
}

/** The three notification_type values that mean "Claude is blocked on you". */
export const BLOCKING_NOTIFICATION_TYPES = [
  "permission_prompt",
  "idle_prompt",
  "agent_needs_input",
] as const;

/** Hard ceiling on how much assistant text ever leaves the Claude process (see hook.js). */
export const MAX_MESSAGE_CHARS = 500;
