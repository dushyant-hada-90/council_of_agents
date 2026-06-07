/** Google Cloud Text-to-Speech voice names for en-IN. */
export const GOOGLE_TTS_VOICES = [
  "en-IN-Wavenet-A",
  "en-IN-Wavenet-B",
  "en-IN-Wavenet-C",
  "en-IN-Wavenet-D",
  "en-IN-Standard-A",
  "en-IN-Standard-B",
  "en-IN-Standard-C",
  "en-IN-Standard-D",
] as const;

export type GoogleTtsVoice = (typeof GOOGLE_TTS_VOICES)[number];

const VOICE_SET = new Set<string>(GOOGLE_TTS_VOICES);

export function normalizeGoogleVoice(
  voice: string | undefined | null,
  fallback: GoogleTtsVoice = "en-IN-Wavenet-A"
): string {
  const v = (voice ?? "").trim();
  if (VOICE_SET.has(v)) return v;
  return fallback;
}

export function normalizeVoice(
  voice: string | undefined | null,
  fallback: GoogleTtsVoice = "en-IN-Wavenet-A"
): string {
  return normalizeGoogleVoice(voice, fallback);
}

export interface AgentConfig {
  id: string;
  name: string;
  voice: string;
  roleSummary: string;
  peerProfile: string;
  systemPrompt: string;
  color: string;
}

export interface MeetingConfig {
  meetingId: string;
  userId: string | null;
  humanName: string;
  topic: string;
  goal: string;
  context: string;
  instructions: string;
  maxAiTurnsBeforeHuman: 2 | 4 | 6;
  agents: AgentConfig[];
  isGuest?: boolean;
  guestSessionId?: string;
  guestIp?: string;
  refinedPrompt?: string;
  initialSpokenSeconds?: number;
}

export const MAX_AI_TURN_OPTIONS = [2, 4, 6] as const;

export type MaxAiTurnsBeforeHuman = 2 | 4 | 6;
