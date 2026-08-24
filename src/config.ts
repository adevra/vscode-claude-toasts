import * as vscode from "vscode";
import { MAX_MESSAGE_CHARS, PolicyConfig } from "./types";

export interface ExtensionConfig extends PolicyConfig {
  sound: boolean;
}

const SECTION = "claudeToasts";

export function readConfig(): ExtensionConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    enabled: c.get<boolean>("enabled", true),
    notifyOnComplete: c.get<boolean>("notifyOnComplete", true),
    notifyOnNeedsInput: c.get<boolean>("notifyOnNeedsInput", true),
    minTurnDurationSeconds: Math.max(0, c.get<number>("minTurnDurationSeconds", 20)),
    suppressWhenActiveTerminal: c.get<boolean>("suppressWhenActiveTerminal", true),
    messagePreviewLength: clamp(c.get<number>("messagePreviewLength", 120), 0, MAX_MESSAGE_CHARS),
    sound: c.get<boolean>("sound", true),
    dedupWindowSeconds: Math.max(0, c.get<number>("dedupWindowSeconds", 5)),
    maxToastsPerMinute: Math.max(1, c.get<number>("maxToastsPerMinute", 10)),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
