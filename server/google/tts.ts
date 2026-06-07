import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import { normalizeGoogleVoice } from "../../lib/agents/types";
import { logger } from "../logger";

let client: TextToSpeechClient | null = null;

function getClient(): TextToSpeechClient {
  if (!client) {
    client = new TextToSpeechClient();
  }
  return client;
}

const SAMPLE_RATE = 24000;

export interface SynthesizeOptions {
  voice?: string;
  speakingRate?: number;
}

/**
 * Synthesize speech to PCM16 mono at 24kHz using Google Cloud TTS.
 */
export async function synthesizeSpeech(
  text: string,
  options: SynthesizeOptions = {}
): Promise<Buffer> {
  const trimmed = text.trim();
  if (!trimmed) return Buffer.alloc(0);

  const voiceName = normalizeGoogleVoice(options.voice);

  try {
    const [response] = await getClient().synthesizeSpeech({
      input: { text: trimmed },
      voice: {
        languageCode: "en-IN",
        name: voiceName,
      },
      audioConfig: {
        audioEncoding: "LINEAR16",
        sampleRateHertz: SAMPLE_RATE,
        speakingRate: options.speakingRate ?? 1.0,
      },
    });

    const content = response.audioContent;
    if (!content || !(content instanceof Uint8Array) && typeof content !== "string") {
      return Buffer.alloc(0);
    }

    const buf = Buffer.isBuffer(content)
      ? content
      : Buffer.from(content as string | Uint8Array);

    logger.info("TTS", `Synthesized ${buf.byteLength} bytes for voice ${voiceName}`);
    return buf;
  } catch (err) {
    logger.error("TTS", `Google TTS failed: ${(err as Error).message}`);
    throw err;
  }
}

/** Split PCM buffer into base64 chunks for streaming to client (~20ms each). */
export function pcmToBase64Chunks(pcm: Buffer, chunkMs = 20): string[] {
  const bytesPerChunk = Math.floor(SAMPLE_RATE * 2 * (chunkMs / 1000));
  const chunks: string[] = [];
  for (let i = 0; i < pcm.byteLength; i += bytesPerChunk) {
    chunks.push(pcm.subarray(i, i + bytesPerChunk).toString("base64"));
  }
  return chunks;
}

export { SAMPLE_RATE as TTS_SAMPLE_RATE };
