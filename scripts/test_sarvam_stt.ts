/**
 * Smoke test for Sarvam STT via transcribePcm16.
 *
 * Usage:
 *   npx tsx scripts/test_sarvam_stt.ts [path/to/audio.wav|path/to/audio.pcm]
 *
 * PCM files are assumed to be 24kHz mono PCM16 (raw, no header).
 * WAV files may be any rate; PCM payload is extracted and sent at 24kHz.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { transcribePcm16 } from "../lib/pipeline/stt";
import { stripWavHeaderIfPresent } from "../lib/pipeline/wav";

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: npx tsx scripts/test_sarvam_stt.ts <audio.wav|audio.pcm>");
    process.exit(1);
  }

  const abs = path.resolve(inputPath);
  if (!fs.existsSync(abs)) {
    console.error(`File not found: ${abs}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(abs);
  const { pcm } = stripWavHeaderIfPresent(raw);
  const audio = pcm.byteLength > 0 ? pcm : raw;

  console.log(`Input: ${abs} (${audio.byteLength} bytes PCM)`);

  const result = await transcribePcm16([audio]);
  console.log("Detail:", result.detail);
  console.log("Transcript:", result.text ?? "(empty)");
  process.exit(result.text ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
