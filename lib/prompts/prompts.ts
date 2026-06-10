/**
 * Gemini prompts — LLM instruction templates.
 *
 * 1. buildPlannerPrompt      — guest meeting setup (structured JSON)
 * 2. buildLiveTurnPrompt       — merged routing + reply (JSON, each live turn)
 * 3. formatLiveMeetingMetadata — meeting + advisor block (once per call)
 */

export const JSON_SYSTEM_SUFFIX =
  "Respond with valid JSON only. No explanation, no markdown.";

export const CHAT_VOICE_APPEND =
  "Keep responses under 15 seconds of speech. Be conversational, not listy.";

/** Appended to Gemini system prompts when Google Search grounding is enabled. */
export const GOOGLE_SEARCH_GROUNDING_RULES = `You can use Google Search for current or time-sensitive facts (news, prices, weather, sports, recent events, "today", "latest").
If the human asks for up-to-date information, search before you answer — do not guess or rely on outdated knowledge.
Weave verified facts into your spoken line naturally; never say "I searched" or "according to the web" aloud.`;

export const LIVE_TURN_VOICE_RULES = `Voice rules for all spoken lines:
- Under 60 words (~20 seconds). First person when speaking as an agent.
- React directly to what was just said. Never read instructions aloud.
- Name one person when addressing them. Push back when you disagree.`;

export function appendChatVoiceRules(system: string): string {
  return `${system}\n\n${CHAT_VOICE_APPEND}`;
}

// ─── 1. Guest planner ───────────────────────────────────────────────────────────

export interface PlannerPromptContext {
  userPrompt: string;
  minAgents: number;
}

export function buildPlannerPrompt(ctx: PlannerPromptContext): {
  system: string;
  user: string;
} {
  const { userPrompt, minAgents } = ctx;
  return {
    system: `You are an expert facilitator for multi-agent voice councils.
Given a user's discussion prompt, refine their agenda and propose exactly ${minAgents} AI advisors who would help them discuss it productively.
Each advisor needs a distinct personality, expertise angle, and speaking style suited to voice conversation.
Keep system prompts focused on voice discussion behavior — short responses, name-based routing, push back when needed.`,
    user: `User prompt: "${userPrompt}"

Return JSON with:
- refinedPrompt: clear 2-3 sentence meeting agenda
- topic, goal, context, instructions: meeting metadata strings
- agents: array of exactly ${minAgents} objects with name, systemPrompt (150-300 words), roleSummary (one line), description (one line)`,
  };
}

// ─── 2. Live turn (merged routing + response) ───────────────────────────────────

export interface LiveMeetingMetadata {
  humanName: string;
  topic: string;
  goal: string;
  context: string;
  instructions: string;
  agents: Array<{
    name: string;
    systemPrompt: string;
    roleSummary?: string;
    peerProfile?: string;
  }>;
}

export function formatLiveMeetingMetadata(meta: LiveMeetingMetadata): string {
  const human = meta.humanName.trim() || "You";
  const agentNames = meta.agents.map((a) => a.name).join(", ");
  const lines = [
    "## Meeting",
    meta.topic ? `Topic: ${meta.topic}` : "",
    meta.goal ? `Goal: ${meta.goal}` : "",
    meta.context ? `Context: ${meta.context}` : "",
    meta.instructions ? `Instructions: ${meta.instructions}` : "",
    `Human participant: ${human} (push-to-talk)`,
    `Advisors at the table: ${agentNames}`,
    "",
    "## Advisors",
  ].filter(Boolean);

  for (const agent of meta.agents) {
    lines.push(`### ${agent.name}`);
    if (agent.roleSummary) lines.push(`Role: ${agent.roleSummary}`);
    if (agent.peerProfile) lines.push(`Profile: ${agent.peerProfile}`);
    lines.push(agent.systemPrompt);
    lines.push("");
  }

  return lines.join("\n").trim();
}

export interface LiveTurnPromptContext {
  humanName: string;
  agentNames: string;
  afterHuman: boolean;
  /** Server cap — handoff line only from last speaker. */
  handoffOnly?: boolean;
  meetingMetadata: string;
  chatTranscript: string;
  lastSpeakerName?: string;
  lastTranscript?: string;
}

export function buildLiveTurnPrompt(ctx: LiveTurnPromptContext): {
  system: string;
  user: string;
} {
  const human = ctx.humanName.trim() || "You";
  const transcript = ctx.chatTranscript || "(session just started)";

  let routingRules: string;
  let jsonShape: string;
  let dynamicInstruction: string;

  if (ctx.handoffOnly) {
    routingRules = [
      `The exchange is pausing — ${ctx.lastSpeakerName ?? "the last speaker"} (see transcript) addresses ${human} with one short engaging line.`,
      `Speak AS that last speaker in "handoff". One line only.`,
    ].join("\n");
    jsonShape = `{"handoff":"<engaging line, first person, under 40 words>"}`;
    dynamicInstruction = `Write ${ctx.lastSpeakerName ?? "the last speaker"}'s single engaging line for ${human}.`;
  } else if (ctx.afterHuman) {
    routingRules = [
      `${human} just spoke — pick one AGENT to reply (never route back to ${human}).`,
      `"next" must be one of: ${ctx.agentNames}.`,
      `If ${human} named an agent, pick that agent.`,
      `Speak AS the chosen agent in "response".`,
    ].join("\n");
    jsonShape = `{"next":"<AgentFirstName>","reason":"<12 words>","response":"<spoken line, first person, under 60 words>"}`;
    dynamicInstruction = `${human} just spoke. Pick an agent and write their reply.`;
  } else {
    routingRules = [
      `An agent just spoke — decide what happens next.`,
      `Another agent reacts: {"next":"<AgentFirstName>","reason":"<12 words>","response":"<spoken line>"}`,
      `Invite ${human} back with one engaging line as the last speaker: {"handoff":"<one line, first person, under 40 words>"}`,
      `Open the mic silently (no spoken line): {"next":"${human}" or "human","reason":"<12 words>","response":""}`,
      `Use "handoff" OR silent human routing — not both. Do not append a separate question after an agent "response".`,
    ].join("\n");
    jsonShape = [
      `{"next":"<AgentFirstName>","reason":"<12 words>","response":"<spoken line>"}`,
      `{"handoff":"<engaging line as last speaker, first person, under 40 words>"}`,
      `{"next":"${human}|human","reason":"<12 words>","response":""}`,
    ].join("\nOR ");
    dynamicInstruction = "Continue the exchange, invite the human back with one line, or open the human's turn.";
  }

  const system = [
    "You route turns and write spoken replies for a live voice council.",
    `Agent first names: ${ctx.agentNames}. Human: ${human}.`,
    routingRules,
    LIVE_TURN_VOICE_RULES,
    `Reply with JSON only:\n${jsonShape}`,
  ].join("\n\n");

  const userParts = [
    ctx.meetingMetadata,
    `Conversation:\n${transcript}`,
  ];
  if (ctx.lastSpeakerName) userParts.push(`Last speaker: ${ctx.lastSpeakerName}`);
  if (ctx.lastTranscript) userParts.push(`Last line: "${ctx.lastTranscript}"`);
  userParts.push(dynamicInstruction);

  return { system, user: userParts.join("\n\n") };
}
