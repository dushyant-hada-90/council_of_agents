/** Helpers tied to AudioContext.currentTime — UI must not run ahead of speakers. */

export interface PlayoutChunkLike {
  startAt: number;
  effectiveDurationSec: number;
}

/** Agent whose audio is reaching the speakers right now. */
export function getHeardAgentAt(
  now: number,
  schedule: Map<string, PlayoutChunkLike[]>
): string | null {
  for (const [agentId, chunks] of schedule) {
    for (const chunk of chunks) {
      const end = chunk.startAt + chunk.effectiveDurationSec;
      if (now >= chunk.startAt && now < end) return agentId;
    }
  }
  return null;
}

/** True while any audio is still scheduled or playing after `now`. */
export function hasQueuedAudioAfter(
  now: number,
  schedule: Map<string, PlayoutChunkLike[]>,
  nextPlayTime: number,
  activeSourceCount: number
): boolean {
  if (activeSourceCount > 0) return true;
  if (nextPlayTime > now + 0.02) return true;
  for (const chunks of schedule.values()) {
    for (const chunk of chunks) {
      if (chunk.startAt + chunk.effectiveDurationSec > now) return true;
    }
  }
  return false;
}

export function deriveDisplayStatus(options: {
  isPTTActive: boolean;
  humanName: string;
  heardAgentName: string | null;
  humanTurnReady: boolean;
  queueBusy: boolean;
}): string {
  if (options.isPTTActive) return `${options.humanName} is speaking`;
  if (options.heardAgentName) return `${options.heardAgentName} is speaking`;
  if (options.humanTurnReady) return "Your turn";
  if (options.queueBusy) return "Listening…";
  return "Idle";
}
