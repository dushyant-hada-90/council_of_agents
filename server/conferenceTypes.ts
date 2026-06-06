/** Playback report sent by the client when the human interrupts mid-queue. */
export interface InterruptPlaybackReport {
  /** Agent IDs whose audio fully played out before the interrupt. */
  fullyHeard: string[];
  /** Agent currently playing — only the heard portion counts. */
  partial: { agentId: string; audioEndMs: number } | null;
  /** Agent IDs whose audio was queued but never reached the speakers. */
  unheard: string[];
}
