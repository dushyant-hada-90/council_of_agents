export type MaxAiTurnsBeforeHuman = 2 | 4 | 6;

export type AgentVoice =
  | "alloy"
  | "ash"
  | "ballad"
  | "cedar"
  | "coral"
  | "echo"
  | "marin"
  | "sage"
  | "shimmer"
  | "verse";

/** Voices supported by OpenAI Realtime API (session.audio.output.voice). */
export const OPENAI_REALTIME_VOICES: readonly AgentVoice[] = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "marin",
  "sage",
  "shimmer",
  "verse",
] as const;

export const OPENAI_VOICES = OPENAI_REALTIME_VOICES;

const VOICE_SET = new Set<string>(OPENAI_REALTIME_VOICES);

/** Map legacy/invalid voice names to a supported Realtime voice. */
const VOICE_ALIASES: Record<string, AgentVoice> = {
  nova: "shimmer",
  fable: "ballad",
  onyx: "ash",
};

export function normalizeVoice(
  voice: string | undefined | null,
  fallback: AgentVoice = "alloy"
): AgentVoice {
  const v = (voice ?? "").trim().toLowerCase();
  if (VOICE_SET.has(v)) return v as AgentVoice;
  if (v in VOICE_ALIASES) return VOICE_ALIASES[v]!;
  return fallback;
}

export interface AgentConfig {
  id: string;
  name: string;
  voice: AgentVoice;
  roleSummary: string;
  peerProfile: string;
  systemPrompt: string;
  color: string;
  provider?: string;
  model?: string;
}

export interface MeetingConfig {
  meetingId: string;
  userId: string;
  humanName: string;
  topic: string;
  goal: string;
  context: string;
  instructions: string;
  maxAiTurnsBeforeHuman: 2 | 4 | 6;
  agents: AgentConfig[];
}

export const MAX_AI_TURN_OPTIONS = [2, 4, 6] as const;
