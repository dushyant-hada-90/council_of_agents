import { getEnv } from "@/lib/env";

/** Target PCM rate for human mic capture and Google STT (matches agent TTS output). */
export const CAPTURE_SAMPLE_RATE = 24000;

/** Bytes per millisecond for PCM16 mono at 24kHz. */
export const PCM16_BYTES_PER_MS = 48;

/** Default segment length when env is unavailable (30s @ 24kHz PCM16). */
export const DEFAULT_HUMAN_STT_SEGMENT_BYTES = 1_440_000;

/** Default overlap between consecutive STT segments (5s @ 24kHz PCM16). */
export const DEFAULT_HUMAN_STT_OVERLAP_BYTES = 240_000;

export function pcm16DurationSec(
  byteLength: number,
  sampleRate = CAPTURE_SAMPLE_RATE
): number {
  return byteLength / (sampleRate * 2);
}

function pcm16BytesForSeconds(seconds: number, sampleRate = CAPTURE_SAMPLE_RATE): number {
  return Math.round(seconds * sampleRate * 2);
}

/** Max PCM bytes per rolling human STT segment (from HUMAN_STT_SEGMENT_SEC). */
export function getHumanSttSegmentBytes(): number {
  const sec = getEnv().HUMAN_STT_SEGMENT_SEC;
  return pcm16BytesForSeconds(sec);
}

/** PCM bytes retained between segments for overlap (from HUMAN_STT_OVERLAP_SEC). */
export function getHumanSttOverlapBytes(): number {
  const sec = getEnv().HUMAN_STT_OVERLAP_SEC;
  return pcm16BytesForSeconds(sec);
}

/** Stride between segment starts: segment size minus overlap. */
export function getHumanSttStrideBytes(): number {
  return getHumanSttSegmentBytes() - getHumanSttOverlapBytes();
}

/** Post-PTT STT wait — bounded by last segment + in-flight segments, not total recording length. */
export function estimateFinalSttTimeoutMs(baseMs: number): number {
  return baseMs + 8_000;
}

/** @deprecated Use getHumanSttSegmentBytes */
export const STT_SYNC_CHUNK_BYTES = DEFAULT_HUMAN_STT_SEGMENT_BYTES;

/** @deprecated Use getHumanSttOverlapBytes */
export const STT_CHUNK_OVERLAP_BYTES = DEFAULT_HUMAN_STT_OVERLAP_BYTES;
