import { getSupabaseAdmin } from "../lib/supabase/admin";
import { logger } from "./logger";

export interface TranscriptBufferEntry {
  speakerId: string;
  speakerName: string;
  speakerType: "human" | "agent";
  message: string;
  timestamp: number;
  partial?: boolean;
  metadata?: Record<string, unknown>;
}

export class TranscriptPersister {
  private readonly buffer: TranscriptBufferEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private destroyed = false;

  constructor(
    private readonly meetingId: string,
    private readonly userId: string,
    private readonly flushIntervalMs: number
  ) {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, flushIntervalMs);
  }

  append(entry: TranscriptBufferEntry): void {
    if (this.destroyed) return;
    this.buffer.push(entry);
  }

  async flush(): Promise<number> {
    if (this.destroyed || this.flushing || this.buffer.length === 0) return 0;

    this.flushing = true;
    const batch = this.buffer.splice(0);

    try {
      const supabase = getSupabaseAdmin();
      const rows = batch.map((e) => ({
        meeting_id: this.meetingId,
        user_id: this.userId,
        speaker_id: e.speakerId,
        speaker_name: e.speakerName,
        speaker_type: e.speakerType,
        message: e.message,
        message_timestamp: new Date(e.timestamp).toISOString(),
        partial: e.partial ?? false,
        metadata: e.metadata ?? {},
      }));

      const { error } = await supabase.from("transcript_messages").insert(rows as never[]);
      if (error) {
        this.buffer.unshift(...batch);
        logger.error("TRANSCRIPT", `Flush failed: ${error.message}`);
        return 0;
      }

      logger.info("TRANSCRIPT", `Flushed ${rows.length} messages for meeting ${this.meetingId}`);
      return rows.length;
    } catch (err) {
      this.buffer.unshift(...batch);
      logger.error("TRANSCRIPT", `Flush error: ${(err as Error).message}`);
      return 0;
    } finally {
      this.flushing = false;
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  get pendingCount(): number {
    return this.buffer.length;
  }
}

/** Flush all active persisters on shutdown. */
const activePersisters = new Set<TranscriptPersister>();

export function registerPersister(p: TranscriptPersister): void {
  activePersisters.add(p);
}

export function unregisterPersister(p: TranscriptPersister): void {
  activePersisters.delete(p);
}

export async function flushAllTranscripts(): Promise<void> {
  await Promise.all([...activePersisters].map((p) => p.destroy()));
}
