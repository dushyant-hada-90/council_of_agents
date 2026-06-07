import type { AgentConfig } from "./types";
import { normalizeVoice } from "./types";

export function buildMeetingRoster(humanName: string, agents: AgentConfig[]): string {
  const agentNames = agents.map((a) => a.name).join(", ");
  const roster = agents
    .map(
      (a) =>
        `- **${a.name}**: ${a.roleSummary}\n  Strengths / weaknesses / useful for: ${a.peerProfile}`
    )
    .join("\n");

  return [
    `## Council roster (${agents.length + 1} participants — all present right now)`,
    `**${humanName}** (the person seeking counsel, push-to-talk) plus advisors: ${agentNames}.`,
    roster,
    `- **${humanName}**: The live human participant. Host and active participant in this discussion.`,
    "",
    "Council rules:",
    `- You KNOW everyone above — they are your co-advisors at this live council, not strangers.`,
    `- When asked how many people are here, who is present, or to describe someone: answer from this roster (${agents.length + 1} total).`,
    `- When asked about another advisor's role, strengths, weaknesses, or what they're good for: answer from their profile.`,
    `- Never say you cannot see the participant list or lack context about who is present.`,
  ].join("\n");
}

function buildRoomContext(self: AgentConfig, humanName: string, all: AgentConfig[]): string {
  const others = all.filter((a) => a.id !== self.id);
  const roster = others
    .map(
      (a) =>
        `- **${a.name}**: ${a.roleSummary}\n  Strengths / weaknesses / useful for: ${a.peerProfile}`
    )
    .join("\n");

  return `
## Council — who is in the room
You are **${self.name}**. ${self.roleSummary}

Other advisors at the table:
${roster}
- **${humanName}**: The live human participant (push-to-talk). When ${humanName} speaks, respond to ${humanName} — never attribute ${humanName}'s words to an advisor.

You are ${self.name}. Answer in first person with your own view. Use everyone's correct names.
When someone says **${self.name}**, they mean YOU — never refer to ${self.name} in third person.

You have known everyone at this table since the council began. Treat their roster profiles as ground truth.
`.trim();
}

const SHARED_CONVERSATIONAL_RULES = `
Keep your vocal responses short — under 20 seconds when spoken aloud (roughly 60 words max).
React directly and specifically to what the previous speaker just said.
Speak as if you are physically present in a frank, high-trust conversation — direct, energetic, invested.
Do NOT narrate your actions. Just respond naturally.
If someone makes a claim you disagree with, push back immediately and specifically.

## Who you are talking to (routing listens for names)
Each turn, speak TO someone on purpose:

**Everyone (open turn):** Make a general point for the whole table.

**One person by name:** To ask or challenge a specific advisor, say their first name clearly once.

**The human:** Only when you want the human to answer next, ask them a direct question using their name.
Name exactly one person when you want a directed reply.
`.trim();

export function buildAgentConfigs(
  humanName: string,
  baseAgents: AgentConfig[],
  meetingContext?: { topic?: string; goal?: string; context?: string; instructions?: string }
): AgentConfig[] {
  const contextBlock = meetingContext
    ? [
        "",
        "## Meeting focus",
        meetingContext.topic ? `Topic: ${meetingContext.topic}` : "",
        meetingContext.goal ? `Goal: ${meetingContext.goal}` : "",
        meetingContext.context ? `Context: ${meetingContext.context}` : "",
        meetingContext.instructions ? `Instructions: ${meetingContext.instructions}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  return baseAgents.map((agent) => ({
    ...agent,
    systemPrompt: [
      agent.systemPrompt,
      SHARED_CONVERSATIONAL_RULES.replace(/\$\{HUMAN_NAME\}/g, humanName),
      buildRoomContext(agent, humanName, baseAgents),
      contextBlock,
    ]
      .filter(Boolean)
      .join("\n\n"),
  }));
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
