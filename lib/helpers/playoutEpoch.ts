/**
 * Playback epoch — incremented on every human interrupt.
 * Audio frames tagged with the current epoch are the only ones forwarded
 * to the client. Stale in-flight chunks from pre-interrupt generations are dropped.
 */
let epoch = 0;

export function getPlayoutEpoch(): number {
  return epoch;
}

export function bumpPlayoutEpoch(): number {
  epoch = (epoch + 1) % 65536; // fits in 2 bytes (Uint16) in binary frame header
  return epoch;
}

export function resetPlayoutEpoch(): void {
  epoch = 0;
}
