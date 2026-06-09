/**
 * Google Cloud TTS LINEAR16 responses include a WAV (RIFF) container.
 * STT and client playback expect raw PCM16 — strip the header when present.
 */
export function stripWavHeaderIfPresent(audio: Buffer): { pcm: Buffer; hadWavHeader: boolean } {
  if (audio.byteLength < 12) {
    return { pcm: audio, hadWavHeader: false };
  }

  if (audio.slice(0, 4).toString("ascii") !== "RIFF" || audio.slice(8, 12).toString("ascii") !== "WAVE") {
    return { pcm: audio, hadWavHeader: false };
  }

  // Walk chunks after "RIFF....WAVE" to find the "data" chunk (header size can vary)
  let offset = 12;
  while (offset + 8 <= audio.byteLength) {
    const chunkId = audio.slice(offset, offset + 4).toString("ascii");
    const chunkSize = audio.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === "data") {
      const end = Math.min(dataStart + chunkSize, audio.byteLength);
      return { pcm: audio.subarray(dataStart, end), hadWavHeader: true };
    }
    offset = dataStart + chunkSize;
    // WAV chunks are word-aligned
    if (chunkSize % 2 === 1) offset += 1;
  }

  // Fallback: standard 44-byte PCM WAV header
  if (audio.byteLength > 44) {
    return { pcm: audio.subarray(44), hadWavHeader: true };
  }

  return { pcm: audio, hadWavHeader: false };
}

/** Wrap raw PCM16 mono in a standard 44-byte WAV header for STT upload. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm.byteLength;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}
