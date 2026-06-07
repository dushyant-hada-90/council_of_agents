import { transcribePcm16 } from "./google/stt";
import { logger } from "./logger";

export type HumanTranscriptSource = "google" | "none" | "error";

export interface HumanTranscriptMeta {
  source: HumanTranscriptSource;
  detail: string;
}

export interface HumanTranscriptResult {
  text: string | null;
  meta: HumanTranscriptMeta;
}

export async function resolveHumanTranscript(
  chunks: Buffer[],
  options?: { captureSampleRate?: number }
): Promise<HumanTranscriptResult> {
  if (chunks.length === 0) {
    const detail = "no audio chunks captured";
    return { text: null, meta: { source: "none", detail } };
  }

  const byteCount = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);

  try {
    const stt = await transcribePcm16(chunks, {
      captureSampleRate: options?.captureSampleRate,
    });
    if (stt.text?.trim()) {
      return {
        text: stt.text.trim(),
        meta: { source: "google", detail: `transcribed ${byteCount} bytes` },
      };
    }

    const detail = stt.detail;
    logger.warn("TRANSCRIBE", `No speech text (${byteCount} bytes): ${detail}`);
    return { text: null, meta: { source: "none", detail } };
  } catch (err) {
    const detail = `unexpected error: ${(err as Error).message}`;
    logger.warn("TRANSCRIBE", detail);
    return { text: null, meta: { source: "error", detail } };
  }
}
