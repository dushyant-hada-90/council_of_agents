const SENTENCE_END = /([.!?]+)\s+/g;

/**
 * Split spoken text into TTS-sized chunks at sentence boundaries.
 * Merges very short trailing fragments into the previous chunk.
 */
export function splitIntoSpeechChunks(text: string, minChunkChars = 10): string[] {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return [];

  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  SENTENCE_END.lastIndex = 0;
  while ((match = SENTENCE_END.exec(trimmed)) !== null) {
    const end = match.index + match[1]!.length;
    const sentence = trimmed.slice(lastIndex, end).trim();
    if (sentence) parts.push(sentence);
    lastIndex = match.index + match[0]!.length;
  }

  const tail = trimmed.slice(lastIndex).trim();
  if (tail) {
    if (tail.length < minChunkChars && parts.length > 0) {
      parts[parts.length - 1] = `${parts[parts.length - 1]!} ${tail}`.trim();
    } else {
      parts.push(tail);
    }
  }

  if (parts.length === 0) return [trimmed];
  return parts;
}
