import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import { normalizeGoogleVoice } from "../../lib/agents/types";
import { getEnv } from "../../lib/env";
import { logger } from "../logger";
import { stripWavHeaderIfPresent } from "./wav";

let client: TextToSpeechClient | null = null;

function getClient(): TextToSpeechClient {
  if (!client) {
    const { GOOGLE_APPLICATION_CREDENTIALS } = getEnv();
    client = new TextToSpeechClient({ keyFilename: GOOGLE_APPLICATION_CREDENTIALS });
  }
  return client;
}

const SAMPLE_RATE = 24000;

export interface SynthesizeOptions {
  voice?: string;
  speakingRate?: number;
}

/**
 * Synthesize speech to raw PCM16 mono at 24kHz using Google Cloud TTS.
 * Strips the WAV header Google returns with LINEAR16 encoding.
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
    if (!content || (!(content instanceof Uint8Array) && typeof content !== "string")) {
      return Buffer.alloc(0);
    }

    const buf = Buffer.isBuffer(content)
      ? content
      : Buffer.from(content as string | Uint8Array);

    const { pcm, hadWavHeader } = stripWavHeaderIfPresent(buf);
    if (hadWavHeader) {
      logger.info(
        "TTS",
        `Stripped WAV header (${buf.byteLength - pcm.byteLength} bytes) → raw PCM ${pcm.byteLength} bytes for ${voiceName}`
      );
    } else {
      logger.info("TTS", `Synthesized ${pcm.byteLength} bytes raw PCM for voice ${voiceName}`);
    }
    return pcm;
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
