/** Temporary mutes, driven by the "Mute" buttons on toasts. Pure and testable. */
export class MuteStore {
  private globalUntil = 0;
  private bySession = new Map<string, number>();

  muteGlobal(untilMs: number): void {
    this.globalUntil = Math.max(this.globalUntil, untilMs);
  }

  muteSession(sessionId: string, untilMs: number): void {
    this.bySession.set(sessionId, Math.max(this.bySession.get(sessionId) ?? 0, untilMs));
  }

  isMuted(sessionId: string, now: number): boolean {
    if (now < this.globalUntil) {
      return true;
    }
    const until = this.bySession.get(sessionId);
    return until != null && now < until;
  }

  clear(): void {
    this.globalUntil = 0;
    this.bySession.clear();
  }

  /** Human-readable summary for the diagnostics command. */
  describe(now: number): string {
    const parts: string[] = [];
    if (now < this.globalUntil) {
      parts.push(`all sessions for ${Math.ceil((this.globalUntil - now) / 60000)}m`);
    }
    for (const [id, until] of this.bySession) {
      if (now < until) {
        parts.push(`${id.slice(0, 8)} for ${Math.ceil((until - now) / 60000)}m`);
      }
    }
    return parts.length > 0 ? parts.join(", ") : "nothing muted";
  }
}
