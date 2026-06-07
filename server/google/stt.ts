import { SpeechClient } from "@google-cloud/speech";
import { logger } from "../logger";

let client: SpeechClient | null = null;

function getClient(): SpeechClient {
  if (!client) {
    client = new SpeechClient();
  }
  return client;
}

const SAMPLE_RATE = 24000;

/**
 * Transcribe PCM16 mono audio at 24kHz using Google Cloud Speech-to-Text.
 */
export async function transcribePcm16(chunks: Buffer[]): Promise<string | null> {
  if (chunks.length === 0) return null;

  const audio = Buffer.concat(chunks);
  if (audio.byteLength < SAMPLE_RATE * 2 * 0.1) return null;

  try {
    const [response] = await getClient().recognize({
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: SAMPLE_RATE,
        languageCode: "en-IN",
        model: "latest_long",
        enableAutomaticPunctuation: true,
      },
      audio: { content: audio.toString("base64") },
    });

    const text = response.results
      ?.map((r) => r.alternatives?.[0]?.transcript ?? "")
      .join(" ")
      .trim();

    if (text) {
      logger.info("STT", `Google STT: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);
      return text;
    }
    return null;
  } catch (err) {
    logger.error("STT", `Google STT failed: ${(err as Error).message}`);
    return null;
  }
}

export { SAMPLE_RATE as STT_SAMPLE_RATE };
