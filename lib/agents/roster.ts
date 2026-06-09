import type { AgentConfig } from "./types";
import { normalizeVoice } from "./types";

/** Personality-only configs for the room — meeting metadata is sent once per Gemini live turn. */
export function buildAgentConfigs(humanName: string, baseAgents: AgentConfig[]): AgentConfig[] {
  void humanName;
  return baseAgents.map((agent) => ({ ...agent }));
}

export function agentRowToConfig(row: {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  voice: string;
  color: string;
  role_summary: string;
  peer_profile: string;
}): AgentConfig {
  return {
    id: row.id,
    name: row.name,
    voice: normalizeVoice(row.voice),
    roleSummary: row.role_summary || row.description,
    peerProfile: row.peer_profile,
    systemPrompt: row.system_prompt,
    color: row.color,
  };
}
