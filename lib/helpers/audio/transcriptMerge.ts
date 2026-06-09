const WORD_SPLIT = /\s+/;

function normalizeWords(text: string): string[] {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return [];
  return trimmed.split(WORD_SPLIT);
}

/** Collapse consecutive identical words (case-insensitive). */
function collapseConsecutiveDuplicateWords(words: string[]): string[] {
  const out: string[] = [];
  for (const word of words) {
    const prev = out[out.length - 1];
    if (prev && prev.toLowerCase() === word.toLowerCase()) continue;
    out.push(word);
  }
  return out;
}

/**
 * Longest suffix of `left` that matches a prefix of `right` (word-level, case-insensitive).
 * Capped by maxOverlapWords (≈ speech in the audio overlap window).
 */
function longestWordOverlap(left: string[], right: string[], maxOverlapWords: number): number {
  const max = Math.min(left.length, right.length, maxOverlapWords);
  for (let len = max; len > 0; len--) {
    let match = true;
    for (let i = 0; i < len; i++) {
      if (left[left.length - len + i]!.toLowerCase() !== right[i]!.toLowerCase()) {
        match = false;
        break;
      }
    }
    if (match) return len;
  }
  return 0;
}

/**
 * Join segment transcripts from overlapping STT windows.
 * Skips duplicated boundary words, then collapses any remaining consecutive duplicates.
 */
export function mergeSegmentTranscripts(
  parts: string[],
  maxOverlapWords = 15
): string {
  const segments = parts.map(normalizeWords).filter((w) => w.length > 0);
  if (segments.length === 0) return "";
  if (segments.length === 1) return segments[0]!.join(" ");

  let merged = [...segments[0]!];
  for (let i = 1; i < segments.length; i++) {
    const next = segments[i]!;
    const overlap = longestWordOverlap(merged, next, maxOverlapWords);
    merged.push(...next.slice(overlap));
    merged = collapseConsecutiveDuplicateWords(merged);
  }

  return merged.join(" ");
}
