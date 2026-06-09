import { GUEST_LIMITS } from "@/lib/config/guestLimits";
import { PCM16_BYTES_PER_MS } from "@/lib/helpers/audio/pcm";
import { getSupabaseAdmin } from "./admin";
import { logger } from "@/lib/logger";

export interface AudioUsageCallbacks {
  onWarning: (remainingSeconds: number) => void;
  onLimitReached: () => void;
}

/**
 * Tracks spoken audio duration from PCM byte counts (server-authoritative).
 */
export class AudioUsageTracker {
  private humanBytes = 0;
  private agentBytes = 0;
  private warned = false;
  private limitReached = false;
  private readonly isGuest: boolean;
  private readonly meetingId: string;
  private readonly guestIp?: string;
  private readonly callbacks: AudioUsageCallbacks;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(options: {
    isGuest: boolean;
    meetingId: string;
    guestIp?: string;
    initialSeconds?: number;
    callbacks: AudioUsageCallbacks;
  }) {
    this.isGuest = options.isGuest;
    this.meetingId = options.meetingId;
    this.guestIp = options.guestIp;
    this.callbacks = options.callbacks;

    const initial = options.initialSeconds ?? 0;
    if (initial > 0) {
      this.humanBytes = Math.floor(initial * 1000 * PCM16_BYTES_PER_MS);
      this.checkThresholds();
    }

    if (this.isGuest) {
      this.persistTimer = setInterval(() => void this.persist(), 30_000);
      this.persistTimer.unref();
    }
  }

  get totalSeconds(): number {
    return (this.humanBytes + this.agentBytes) / PCM16_BYTES_PER_MS / 1000;
  }

  get isLimitReached(): boolean {
    return this.limitReached;
  }

  addHumanAudio(bytes: number): void {
    if (!this.isGuest || this.limitReached) return;
    this.humanBytes += bytes;
    this.checkThresholds();
  }

  addAgentAudio(bytes: number): void {
    if (!this.isGuest || this.limitReached) return;
    this.agentBytes += bytes;
    this.checkThresholds();
  }

  /** Returns true if new agent turns should be blocked. */
  shouldBlockNewTurns(): boolean {
    return this.isGuest && this.limitReached;
  }

  private checkThresholds(): void {
    const total = this.totalSeconds;

    if (!this.warned && total >= GUEST_LIMITS.audioWarnSeconds) {
      this.warned = true;
      const remaining = Math.max(0, GUEST_LIMITS.audioMaxSeconds - total);
      this.callbacks.onWarning(Math.round(remaining));
    }

    if (!this.limitReached && total >= GUEST_LIMITS.audioMaxSeconds) {
      this.limitReached = true;
      this.callbacks.onLimitReached();
      logger.info("AUDIO_LIMIT", `Meeting ${this.meetingId} reached ${total.toFixed(1)}s spoken audio limit`);
    }
  }

  private async persist(): Promise<void> {
    try {
      const supabase = getSupabaseAdmin();
      const seconds = this.totalSeconds;

      await supabase
        .from("meetings")
        .update({ spoken_audio_seconds: seconds } as never)
        .eq("id", this.meetingId);

      if (this.guestIp) {
        await supabase.from("guest_ip_usage").upsert(
          {
            ip_address: this.guestIp,
            spoken_audio_seconds: seconds,
            last_meeting_id: this.meetingId,
          } as never,
          { onConflict: "ip_address" }
        );
      }
    } catch (err) {
      logger.warn("AUDIO_LIMIT", `Failed to persist usage: ${(err as Error).message}`);
    }
  }

  async destroy(): Promise<void> {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
  }
}

/** Check if IP has already exhausted guest audio quota. */
export async function getGuestIpUsageSeconds(ip: string): Promise<number> {
  try {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("guest_ip_usage")
      .select("spoken_audio_seconds")
      .eq("ip_address", ip)
      .maybeSingle();

    return Number((data as { spoken_audio_seconds?: number } | null)?.spoken_audio_seconds ?? 0);
  } catch {
    return 0;
  }
}

export async function isGuestIpOverLimit(ip: string): Promise<boolean> {
  const used = await getGuestIpUsageSeconds(ip);
  return used >= GUEST_LIMITS.audioMaxSeconds;
}
