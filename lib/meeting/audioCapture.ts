export {
  CAPTURE_SAMPLE_RATE,
  DEFAULT_HUMAN_STT_SEGMENT_BYTES,
  pcm16DurationSec,
  getHumanSttSegmentBytes,
} from "@/lib/helpers/audio/pcm";

/** Downsample mono float32 PCM (linear interpolation). */
export function downsampleFloat32(
  input: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate) return input;
  if (fromRate < toRate || fromRate <= 0 || toRate <= 0) return input;

  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  if (outLength <= 0) return new Float32Array(0);

  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = input[idx] ?? 0;
    const s1 = input[Math.min(idx + 1, input.length - 1)] ?? s0;
    output[i] = s0 + frac * (s1 - s0);
  }
  return output;
}

export function float32ToPcm16(input: Float32Array): Int16Array {
  const pcm16 = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    pcm16[i] = Math.max(-32768, Math.min(32767, input[i]! * 32768));
  }
  return pcm16;
}
