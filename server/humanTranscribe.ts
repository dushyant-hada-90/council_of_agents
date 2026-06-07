import { transcribePcm16 } from "./google/stt";
import { logger } from "./logger";

export type HumanTranscriptSource = "google" | "none";

export async function resolveHumanTranscript(
  chunks: Buffer[]
): Promise<{ text: string | null; source: HumanTranscriptSource }> {
  if (chunks.length === 0) {
    return { text: null, source: "none" };
  }

  try {
    const text = await transcribePcm16(chunks);
    if (text?.trim()) {
      return { text: text.trim(), source: "google" };
    }
  } catch (err) {
    logger.warn("TRANSCRIBE", `Google STT failed: ${(err as Error).message}`);
  }

  return { text: null, source: "none" };
}
