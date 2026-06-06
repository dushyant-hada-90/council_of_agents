import { HumanTranscriptionSession } from "./humanTranscriptionSession";
import { logger } from "./logger";

const REALTIME_TRANSCRIPT_TIMEOUT_MS =
  Number(process.env.HUMAN_REALTIME_TRANSCRIPT_TIMEOUT_MS) || 5000;

function pcm16ToWav(pcm: Buffer): Buffer {
  const sampleRate = 24000;
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const header = Buffer.allocUnsafe(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

async function postTranscription(
  wav: Buffer,
  url: string,
  apiKey: string,
  model: string,
  label: string
): Promise<string | null> {
  const formData = new FormData();
  const blob = new Blob([wav], { type: "audio/wav" });
  formData.append("file", blob, "speech.wav");
  formData.append("model", model);
  formData.append("language", "en");

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    logger.warn("TRANSCRIBE", `${label} error ${resp.status}: ${errText.slice(0, 160)}`);
    return null;
  }

  const json = (await resp.json()) as { text?: string };
  return json.text?.trim() ?? null;
}

export type HumanTranscriptSource = "realtime" | "groq" | "openai" | "none";

/**
 * Batch fallback — Groq Whisper when GROQ_API_KEY is set, otherwise OpenAI Whisper.
 * Only one provider is used (not both).
 */
async function transcribeHumanSpeechFallback(
  chunks: Buffer[],
  options: { groqApiKey?: string; openaiApiKey?: string }
): Promise<{ text: string | null; source: "groq" | "openai" | "none" }> {
  if (chunks.length === 0) return { text: null, source: "none" };

  const pcm = Buffer.concat(chunks);
  if (pcm.length < 3200) return { text: null, source: "none" };

  const wav = pcm16ToWav(pcm);
  const groqKey = options.groqApiKey?.trim();
  const openaiKey = options.openaiApiKey?.trim();

  if (groqKey) {
    try {
      const text = await postTranscription(
        wav,
        "https://api.groq.com/openai/v1/audio/transcriptions",
        groqKey,
        "whisper-large-v3-turbo",
        "Groq"
      );
      return { text, source: "groq" };
    } catch (err) {
      logger.warn("TRANSCRIBE", `Groq fallback failed: ${(err as Error).message}`);
      return { text: null, source: "none" };
    }
  }

  if (openaiKey) {
    try {
      const text = await postTranscription(
        wav,
        "https://api.openai.com/v1/audio/transcriptions",
        openaiKey,
        "whisper-1",
        "OpenAI"
      );
      return { text, source: "openai" };
    } catch (err) {
      logger.warn("TRANSCRIBE", `OpenAI Whisper fallback failed: ${(err as Error).message}`);
      return { text: null, source: "none" };
    }
  }

  logger.warn("TRANSCRIBE", "No fallback API key configured");
  return { text: null, source: "none" };
}

/**
 * Resolve human PTT transcript: realtime first, batch fallback only on failure.
 */
export async function resolveHumanTranscript(
  chunks: Buffer[],
  options: {
    realtimeSession: HumanTranscriptionSession | null;
    groqApiKey?: string;
    openaiApiKey?: string;
  }
): Promise<{ text: string | null; source: HumanTranscriptSource }> {
  if (options.realtimeSession?.state === "READY") {
    const realtimeText = await options.realtimeSession.commitAndWaitForTranscript(
      REALTIME_TRANSCRIPT_TIMEOUT_MS
    );
    if (realtimeText) {
      return { text: realtimeText, source: "realtime" };
    }
    logger.warn("TRANSCRIBE", "Realtime transcription failed — trying batch fallback");
  } else {
    logger.warn("TRANSCRIBE", "Realtime session unavailable — trying batch fallback");
  }

  const fallback = await transcribeHumanSpeechFallback(chunks, options);
  return fallback;
}
