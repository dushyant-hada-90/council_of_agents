import { mergeSegmentTranscripts } from "@/lib/helpers/audio/transcriptMerge";
import {
  getHumanSttOverlapBytes,
  getHumanSttSegmentBytes,
  getHumanSttStrideBytes,
  pcm16DurationSec,
} from "@/lib/helpers/audio/pcm";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { transcribePcm16, cleanupSttTranscript } from "./stt";
import type { HumanTranscriptMeta } from "./humanTranscribe";

const STT_CLEANUP_MIN_DURATION_SEC = 10;

export interface HumanSegmentTranscriberOptions {
  onFirstSegmentSubmit?: () => void;
}

interface SegmentJob {
  index: number;
  promise: Promise<string | null>;
}

/**
 * Rolling human STT: fires Google recognize every ~30s during PTT,
 * keeps 5s audio overlap, merges transcripts on finalize.
 */
export class HumanSegmentTranscriber {
  private buffer = Buffer.alloc(0);
  private readonly segmentJobs: SegmentJob[] = [];
  private segmentCount = 0;
  private wsChunkCount = 0;
  private totalBytesReceived = 0;
  private readonly onFirstSegmentSubmit?: () => void;
  private firstSubmitFired = false;
  private aborted = false;

  constructor(options?: HumanSegmentTranscriberOptions) {
    this.onFirstSegmentSubmit = options?.onFirstSegmentSubmit;
  }

  get bytesReceived(): number {
    return this.totalBytesReceived;
  }

  get chunkCount(): number {
    return this.wsChunkCount;
  }

  appendChunk(chunk: Buffer): void {
    if (this.aborted) return;
    this.wsChunkCount++;
    this.totalBytesReceived += chunk.byteLength;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drainFullSegments();
  }

  private drainFullSegments(): void {
    const segmentBytes = getHumanSttSegmentBytes();
    const overlapBytes = getHumanSttOverlapBytes();
    const strideBytes = getHumanSttStrideBytes();

    while (this.buffer.byteLength >= segmentBytes) {
      const segmentPcm = this.buffer.subarray(0, segmentBytes);
      this.buffer = this.buffer.subarray(strideBytes);
      this.enqueueSegment(segmentPcm);
    }

    if (overlapBytes >= segmentBytes) {
      logger.warn(
        "TRANSCRIBE",
        `HUMAN_STT_OVERLAP_SEC >= HUMAN_STT_SEGMENT_SEC — overlap must be smaller than segment`
      );
    }
  }

  private enqueueSegment(segmentPcm: Buffer): void {
    const index = this.segmentCount++;
    const job: SegmentJob = {
      index,
      promise: this.transcribeSegment(segmentPcm, index),
    };
    this.segmentJobs.push(job);
  }

  private async transcribeSegment(segmentPcm: Buffer, index: number): Promise<string | null> {
    if (this.aborted) return null;

    if (!this.firstSubmitFired) {
      this.firstSubmitFired = true;
      this.onFirstSegmentSubmit?.();
    }

    try {
      const result = await transcribePcm16([segmentPcm], {
        skipGeminiCleanup: true,
      });
      if (result.text?.trim()) {
        logger.info("TRANSCRIBE", `Segment ${index} OK (${segmentPcm.byteLength}B)`);
        return result.text.trim();
      }
      logger.warn("TRANSCRIBE", `Segment ${index} empty: ${result.detail}`);
      return null;
    } catch (err) {
      logger.warn("TRANSCRIBE", `Segment ${index} failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Flush tail audio and merge all segment transcripts. */
  async finalize(): Promise<{ text: string | null; meta: HumanTranscriptMeta }> {
    if (this.buffer.byteLength > 0) {
      this.enqueueSegment(this.buffer);
      this.buffer = Buffer.alloc(0);
    }

    const texts: string[] = [];
    for (const job of this.segmentJobs) {
      const text = await job.promise;
      if (text) texts.push(text);
    }

    if (texts.length === 0) {
      const detail =
        this.totalBytesReceived === 0
          ? "no audio chunks captured"
          : `no speech in ${this.segmentJobs.length} segment(s), ${this.totalBytesReceived} bytes`;
      return { text: null, meta: { source: "none", detail } };
    }

    let merged = mergeSegmentTranscripts(texts);
    if (!merged) {
      return {
        text: null,
        meta: { source: "none", detail: "merged transcript empty" },
      };
    }

    const durationSec = pcm16DurationSec(this.totalBytesReceived);
    if (
      durationSec > STT_CLEANUP_MIN_DURATION_SEC &&
      getEnv().GEMINI_STT_CLEANUP
    ) {
      merged = await cleanupSttTranscript(merged);
    }

    return {
      text: merged,
      meta: {
        source: "google",
        detail: `transcribed ${this.totalBytesReceived} bytes in ${this.segmentJobs.length} segment(s)`,
      },
    };
  }

  /** Cancel in-flight work when a new PTT starts before finalize completes. */
  abort(): void {
    this.aborted = true;
    this.buffer = Buffer.alloc(0);
    this.segmentJobs.length = 0;
  }
}
