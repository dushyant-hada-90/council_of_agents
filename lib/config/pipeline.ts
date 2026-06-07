/** Google STT → Gemini chat → Google TTS pipeline tuning. */
export const CHAT_TUNING = {
  maxTokens: 150,
  temperature: 0.85,
  systemPromptAppend:
    "Keep responses under 30 seconds of speech. Be conversational, not listy.",
} as const;
