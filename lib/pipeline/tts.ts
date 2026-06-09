import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import { normalizeGoogleVoice } from "@/lib/agents/types";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { logApiError, logApiRequest, logApiResponse, previewText } from "@/lib/logger/apiLog";
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

  if (trimmed.length > 4000) {
    logger.warn(
      "TTS",
      `Input text is ${trimmed.length} chars — Google TTS has a 5000 byte limit; response may truncate`
    );
  }

  const voiceName = normalizeGoogleVoice(options.voice);
  const reqStarted = logApiRequest(
    "TTS",
    "synthesizeSpeech",
    `voice=${voiceName}, ${trimmed.length} chars, "${previewText(trimmed, 60)}"`
  );

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
      logApiResponse("TTS", reqStarted, "synthesizeSpeech", "empty audioContent");
      return Buffer.alloc(0);
    }

    const buf = Buffer.isBuffer(content)
      ? content
      : Buffer.from(content as string | Uint8Array);

    const { pcm, hadWavHeader } = stripWavHeaderIfPresent(buf);
    const durationSec = (pcm.byteLength / (SAMPLE_RATE * 2)).toFixed(1);
    logApiResponse(
      "TTS",
      reqStarted,
      "synthesizeSpeech",
      `${pcm.byteLength}B PCM (~${durationSec}s)${hadWavHeader ? ", wav stripped" : ""}`
    );
    return pcm;
  } catch (err) {
    logApiError("TTS", reqStarted, "synthesizeSpeech", (err as Error).message);
    throw err;
  }
}

/** Split PCM buffer into base64 chunks for streaming to client (~40ms each). */
export function pcmToBase64Chunks(pcm: Buffer, chunkMs = 40): string[] {
  const bytesPerChunk = Math.floor(SAMPLE_RATE * 2 * (chunkMs / 1000));
  const chunks: string[] = [];
  for (let i = 0; i < pcm.byteLength; i += bytesPerChunk) {
    chunks.push(pcm.subarray(i, i + bytesPerChunk).toString("base64"));
  }
  return chunks;
}

export { SAMPLE_RATE as TTS_SAMPLE_RATE };
