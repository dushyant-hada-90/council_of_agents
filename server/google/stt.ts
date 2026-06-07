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
const MIN_BYTES = SAMPLE_RATE * 2 * 0.1;

export interface TranscribeResult {
  text: string | null;
  detail: string;
}

/**
 * Transcribe PCM16 mono audio at 24kHz using Google Cloud Speech-to-Text.
 */
export async function transcribePcm16(chunks: Buffer[]): Promise<TranscribeResult> {
  if (chunks.length === 0) {
    return { text: null, detail: "no audio chunks" };
  }

  const audio = Buffer.concat(chunks);
  if (audio.byteLength < MIN_BYTES) {
    return {
      text: null,
      detail: `audio too short (${audio.byteLength}B < ${MIN_BYTES}B minimum for STT)`,
    };
  }

  try {
    const [response] = await getClient().recognize({
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: SAMPLE_RATE,
        languageCode: "en-IN",
        // en-US / en-GB as fallbacks in case speaker doesn't match en-IN model
        alternativeLanguageCodes: ["en-US", "en-GB"],
        // latest_short is tuned for conversational push-to-talk utterances (< 1 min)
        model: "latest_short",
        enableAutomaticPunctuation: true,
        useEnhanced: true,
      },
      audio: { content: audio.toString("base64") },
    });

    const text = response.results
      ?.map((r) => r.alternatives?.[0]?.transcript ?? "")
      .join(" ")
      .trim();

    if (text) {
      logger.info("STT", `Google STT: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);
      return { text, detail: "ok" };
    }

    return {
      text: null,
      detail: `Google STT returned empty transcript (${audio.byteLength} bytes, no speech detected)`,
    };
  } catch (err) {
    const message = (err as Error).message;
    logger.error("STT", `Google STT failed: ${message}`);
    return { text: null, detail: `Google STT API error: ${message}` };
  }
}

export { SAMPLE_RATE as STT_SAMPLE_RATE };
