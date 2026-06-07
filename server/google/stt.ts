import { SpeechClient } from "@google-cloud/speech";
import { getEnv } from "../../lib/env";
import { logger } from "../logger";
import { stripWavHeaderIfPresent } from "./wav";

let client: SpeechClient | null = null;

function getClient(): SpeechClient {
  if (!client) {
    const { GOOGLE_APPLICATION_CREDENTIALS } = getEnv();
    client = new SpeechClient({ keyFilename: GOOGLE_APPLICATION_CREDENTIALS });
  }
  return client;
}

export const STT_SAMPLE_RATE = 24000;
const MIN_BYTES = STT_SAMPLE_RATE * 2 * 0.1;

export interface TranscribeResult {
  text: string | null;
  detail: string;
}

export interface TranscribeOptions {
  /** Sample rate the browser actually captured at (before any client resample). */
  captureSampleRate?: number;
}

function detectContainerFormat(header: Buffer): string {
  if (header.length < 4) return "unknown (too short)";
  const hex = header.slice(0, 4).toString("hex");
  if (hex.startsWith("1a45dfa3")) return "WEBM (use WEBM_OPUS, not LINEAR16)";
  if (hex.startsWith("4f676753")) return "OGG (use OGG_OPUS, not LINEAR16)";
  if (hex.startsWith("52494646")) return "WAV/RIFF (will strip header before STT)";
  if (header.slice(4, 8).toString("ascii") === "ftyp") return "MP4 (use MP4 encoding, not LINEAR16)";
  return "raw_pcm (no container header — expected for LINEAR16)";
}

function computeRmsDb(audio: Buffer): number {
  const samples = new Int16Array(audio.buffer, audio.byteOffset, audio.byteLength / 2);
  let sumSq = 0;
  const step = Math.max(1, Math.floor(samples.length / 2000));
  for (let i = 0; i < samples.length; i += step) {
    const s = samples[i]! / 32768;
    sumSq += s * s;
  }
  const sampleCount = Math.ceil(samples.length / step);
  const rms = Math.sqrt(sumSq / sampleCount);
  return Math.round(20 * Math.log10(rms + 1e-9));
}

function durationSecAtRate(byteLength: number, sampleRate: number): number {
  return byteLength / (sampleRate * 2);
}

function buildSttConfig(sampleRateHertz: number) {
  return {
    encoding: "LINEAR16" as const,
    sampleRateHertz,
    audioChannelCount: 1,
    languageCode: "en-IN",
    alternativeLanguageCodes: ["en-US", "en-GB"],
    model: "latest_long",
    enableAutomaticPunctuation: true,
    useEnhanced: true,
  };
}

function logSttDiagnostics(
  rawAudio: Buffer,
  audio: Buffer,
  hadWavHeader: boolean,
  rmsDb: number,
  sttConfig: ReturnType<typeof buildSttConfig>,
  captureSampleRate?: number
): void {
  const header = rawAudio.slice(0, 4);
  const format = detectContainerFormat(header);
  const samples = new Int16Array(audio.buffer, audio.byteOffset, Math.min(audio.byteLength / 2, 5000));
  let peak = 0;
  for (let i = 0; i < samples.length; i += 10) {
    peak = Math.max(peak, Math.abs(samples[i] ?? 0));
  }

  logger.info("STT", `Audio header hex: ${header.toString("hex")} → ${format}`);
  if (hadWavHeader) {
    logger.info(
      "STT",
      `Stripped WAV header (${rawAudio.byteLength - audio.byteLength} bytes) → PCM payload ${audio.byteLength} bytes`
    );
  }
  logger.info(
    "STT",
    `PCM bytes: ${audio.byteLength}, dBFS: ${rmsDb}, peak sample: ${peak}, duration @24kHz: ${durationSecAtRate(audio.byteLength, STT_SAMPLE_RATE).toFixed(2)}s`
  );
  if (captureSampleRate && captureSampleRate !== STT_SAMPLE_RATE) {
    logger.warn(
      "STT",
      `Client capture rate ${captureSampleRate}Hz ≠ STT rate ${STT_SAMPLE_RATE}Hz — client should resample before send`
    );
  }
  logger.info("STT", `STT config: ${JSON.stringify(sttConfig)}`);
}

/**
 * Transcribe PCM16 mono audio using Google Cloud Speech-to-Text.
 * Accepts raw PCM or WAV-wrapped LINEAR16 (header stripped automatically).
 */
export async function transcribePcm16(
  chunks: Buffer[],
  options?: TranscribeOptions
): Promise<TranscribeResult> {
  if (chunks.length === 0) {
    return { text: null, detail: "no audio chunks" };
  }

  const rawAudio = Buffer.concat(chunks);
  const captureSampleRate = options?.captureSampleRate;

  // Reject non-WAV container formats early
  const format = detectContainerFormat(rawAudio.slice(0, 4));
  if (format.includes("WEBM") || format.includes("OGG") || format.includes("MP4")) {
    return {
      text: null,
      detail: `Wrong audio format for LINEAR16 STT: ${format}`,
    };
  }

  const { pcm: audio, hadWavHeader } = stripWavHeaderIfPresent(rawAudio);

  if (audio.byteLength < MIN_BYTES) {
    return {
      text: null,
      detail: `audio too short (${audio.byteLength}B PCM < ${MIN_BYTES}B minimum for STT${hadWavHeader ? ", after WAV strip" : ""})`,
    };
  }

  try {
    const rmsDb = computeRmsDb(audio);

    if (rmsDb < -55) {
      return {
        text: null,
        detail: `Audio is silent (${rmsDb} dBFS, ${audio.byteLength} bytes PCM) — skipped STT`,
      };
    }

    const sttConfig = buildSttConfig(STT_SAMPLE_RATE);
    logSttDiagnostics(rawAudio, audio, hadWavHeader, rmsDb, sttConfig, captureSampleRate);

    const [response] = await getClient().recognize({
      config: sttConfig,
      audio: { content: audio.toString("base64") },
    });

    const text = response.results
      ?.map((r) => r.alternatives?.[0]?.transcript ?? "")
      .join(" ")
      .trim();

    if (text) {
      logger.info(
        "STT",
        `Google STT: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}" (${rmsDb} dBFS)`
      );
      return { text, detail: "ok" };
    }

    const mismatchHint =
      captureSampleRate && captureSampleRate !== STT_SAMPLE_RATE
        ? ` — possible sample-rate mismatch (captured @ ${captureSampleRate}Hz, STT @ ${STT_SAMPLE_RATE}Hz)`
        : hadWavHeader
          ? " — WAV header was stripped; verify PCM sample rate"
          : "";

    return {
      text: null,
      detail: `Google STT returned empty transcript (${audio.byteLength} bytes PCM, ${rmsDb} dBFS, no speech detected)${mismatchHint}`,
    };
  } catch (err) {
    const message = (err as Error).message;
    logger.error("STT", `Google STT failed: ${message}`);
    return { text: null, detail: `Google STT API error: ${message}` };
  }
}
