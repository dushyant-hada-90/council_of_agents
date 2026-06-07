import { agentNamesMatch, findAgentByNameToken, normalizeAgentNameToken } from "./nameMatching";
import { logger } from "./logger";

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
/** Turn-taking router — override with GROQ_ROUTING_MODEL. */
const GROQ_MODEL =
  process.env.GROQ_ROUTING_MODEL?.trim() ||
  "meta-llama/llama-4-scout-17b-16e-instruct";
const DEFAULT_TIMEOUT_MS = Number(process.env.GROQ_ROUTING_TIMEOUT_MS) || 3000;

export interface ConversationTurn {
  speaker: string;
  speakerId: string;
  role: "human" | "agent";
  text: string;
}

export type NextSpeakerPick =
  | { source: "groq"; kind: "agent"; agentId: string; agentName: string; reason?: string }
  | { source: "groq"; kind: "human"; reason?: string }
  | { source: "random"; kind: "random" };

export type ChainContinueDecision =
  | { source: "groq"; continue: boolean; reason?: string }
  | { source: "fallback"; continue: boolean };

export interface PickNextSpeakerInput {
  apiKey: string;
  humanName: string;
  turns: ConversationTurn[];
  candidates: Array<{ id: string; name: string }>;
  lastSpeakerId?: string;
  /** Recent speakers — context for Groq only, not a hard block. */
  recentSpeakerIds?: string[];
  /** human_turn = Human just spoke; chain = agent-to-agent continuation */
  context: "human_turn" | "chain";
  timeoutMs?: number;
}

export interface ShouldContinueChainInput {
  apiKey: string;
  humanName: string;
  turns: ConversationTurn[];
  chainTurnCount: number;
  lastSpeakerName: string;
  lastTranscript: string;
  /** Who the last speaker addressed — affects whether the chain should keep going. */
  addresseeKind: "human" | "everyone" | "agent";
  addresseeName?: string;
  timeoutMs?: number;
}

/** True when Groq picked the live human participant (by name, "human", or "you"). */
function isHumanSpeakerPick(next: string, humanName: string): boolean {
  const n = next.trim().toLowerCase();
  if (!n || n === "random") return false;
  if (n === "human" || n === "you") return true;

  const human = humanName.trim().toLowerCase();
  if (!human) return false;
  if (n === human || human.includes(n) || n.includes(human)) return true;

  const first = human.split(/\s+/)[0];
  if (first && first.length >= 2 && n === first) return true;

  return false;
}

/**
 * Ask Groq who should speak next based on conversational flow.
 * Returns { kind: "random" } on any failure — caller runs weighted lottery.
 */
export async function pickNextSpeakerWithGroq(
  input: PickNextSpeakerInput
): Promise<NextSpeakerPick> {
  const { apiKey, humanName, turns, candidates, lastSpeakerId, recentSpeakerIds, context } = input;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const human = humanName.trim() || "You";

  if (!apiKey || candidates.length === 0) {
    return { source: "random", kind: "random" };
  }

  const agentNames = candidates.map((c) => c.name).join(", ");
  const lastSpeakerName = lastSpeakerId
    ? candidates.find((c) => c.id === lastSpeakerId)?.name
    : undefined;
  const recentSpeakerNames =
    recentSpeakerIds
      ?.map((id) => candidates.find((c) => c.id === id)?.name)
      .filter((n): n is string => Boolean(n)) ?? [];
  const recentHint =
    recentSpeakerNames.length > 0
      ? `Recently spoke (most recent last): ${recentSpeakerNames.join(", ")}.`
      : "";
  const recent = turns
    .slice(-14)
    .map((t) => `${t.speaker}: ${t.text}`)
    .join("\n");

  const contextHint =
    context === "human_turn"
      ? `${human} (the live human) just spoke. Pick which agent should respond to ${human}.`
      : "An agent just finished. Pick who should speak next in the natural back-and-forth.";

  const system = `You are the turn-taking router for a live voice conference.
${contextHint}

Agents (use exact first names): ${agentNames}
Also present: ${human} (live human with push-to-talk).

Rules:
${recentHint ? `- ${recentHint}` : ""}
- Pick who should SPEAK next — not who is being discussed. "I'd like to hear from Vikram about Priya" → Vikram speaks, not Priya.
- "hear from X", "turn to X", "I want X's take" → X should speak even if other names appear as the topic.
- A name mentioned only as the subject ("what do you think about Priya") is NOT the speaker unless they were invited to respond.
- If the last line was from ${human}, pick the agent ${human} is clearly inviting to respond.
- If the floor is open with no invite, pick who would naturally jump in (expertise, disagreement, emotional reaction).
- The same agent may speak twice in a row when finishing an answer, clarifying, or responding to a follow-up aimed at them — pick them if that is the natural next turn.
- Pick "${human}" or "human" only if the last speaker asked ${human} a direct question and it is their turn to reply.
- Pick "random" only when the floor is genuinely open with no natural next speaker.

Reply with JSON only: {"next":"<AgentFirstName|${human}|human|random>","reason":"<max 12 words>"}`;

  const user = [
    `Conversation so far:\n${recent || "(session just started)"}`,
    lastSpeakerName ? `Last speaker: ${lastSpeakerName}` : "",
    "\nWho should speak next?",
  ]
    .filter(Boolean)
    .join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.15,
        max_tokens: 64,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      logger.warn("GROQ", `API ${resp.status}: ${errBody.slice(0, 120)}`);
      return { source: "random", kind: "random" };
    }

    const body = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = body.choices?.[0]?.message?.content?.trim();
    if (!raw) return { source: "random", kind: "random" };

    const parsed = JSON.parse(raw) as { next?: string; reason?: string };
    const next = String(parsed.next ?? "").trim();
    const reason = parsed.reason ? String(parsed.reason) : undefined;

    if (/^random$/i.test(next)) {
      logger.warn("GROQ", `Router → random (${reason ?? "open floor"})`);
      return { source: "random", kind: "random" };
    }

    if (isHumanSpeakerPick(next, human)) {
      logger.info("GROQ", `Router → ${human} (${reason ?? ""})`);
      return { source: "groq", kind: "human", reason };
    }

    const byExact = candidates.find(
      (c) =>
        c.name.toLowerCase() === next.toLowerCase() ||
        agentNamesMatch(next, c.name)
    );
    if (byExact) {
      logger.info("GROQ", `Router → ${byExact.name} (${reason ?? ""})`);
      return {
        source: "groq",
        kind: "agent",
        agentId: byExact.id,
        agentName: byExact.name,
        reason,
      };
    }

    const nextNorm = normalizeAgentNameToken(next);
    const byPartial =
      findAgentByNameToken(next, candidates) ??
      candidates.find(
        (c) =>
          next.toLowerCase().includes(c.name.toLowerCase()) ||
          nextNorm.includes(normalizeAgentNameToken(c.name))
      );
    if (byPartial) {
      logger.info("GROQ", `Router → ${byPartial.name} (fuzzy, ${reason ?? ""})`);
      return {
        source: "groq",
        kind: "agent",
        agentId: byPartial.id,
        agentName: byPartial.name,
        reason,
      };
    }

    logger.warn("GROQ", `Unmapped next="${next}" — random fallback`);
    return { source: "random", kind: "random" };
  } catch (err) {
    logger.warn("GROQ", `pick failed: ${(err as Error).message}`);
    return { source: "random", kind: "random" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask Groq whether agent-to-agent chain reactions should continue.
 * Replaces a fixed turn cap — heated debates may run longer; factual Q&A may stop sooner.
 */
export async function shouldContinueChainWithGroq(
  input: ShouldContinueChainInput
): Promise<ChainContinueDecision> {
  const {
    apiKey,
    humanName,
    turns,
    chainTurnCount,
    lastSpeakerName,
    lastTranscript,
    addresseeKind,
    addresseeName,
  } = input;
  const human = humanName.trim() || "You";
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!apiKey) {
    return { source: "fallback", continue: Math.random() < 0.8 };
  }

  const recent = turns
    .slice(-12)
    .map((t) => `${t.speaker}: ${t.text}`)
    .join("\n");

  const addresseeHint =
    addresseeKind === "agent" && addresseeName
      ? `${lastSpeakerName} directly addressed ${addresseeName} — the chain likely continues.`
      : addresseeKind === "everyone"
        ? `${lastSpeakerName} spoke to the open table.`
        : `${lastSpeakerName} asked ${human} a question.`;

  const system = `You decide whether a live voice conference should allow another agent-to-agent reaction turn.

${addresseeHint}
Agent-to-agent turns so far since the human last spoke: ${chainTurnCount}.

Continue the chain when:
- Unresolved disagreement, debate tension, or an open challenge needs a reply
- Someone was named and expects a direct response
- The topic is still actively developing between agents

Stop the chain (return continue=false) when:
- The point feels naturally settled or acknowledged
- The exchange was a simple factual answer with nothing to push back on
- Agents are starting to repeat themselves
- It is time to invite ${human} back into the conversation

Reply with JSON only: {"continue":true|false,"reason":"<max 12 words>"}`;

  const user = `Recent conversation:\n${recent || "(empty)"}\n\nLast line from ${lastSpeakerName}: "${lastTranscript}"\n\nShould another agent react?`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.1,
        max_tokens: 48,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      logger.warn("GROQ", `Chain API ${resp.status}: ${errBody.slice(0, 120)}`);
      return { source: "fallback", continue: Math.random() < 0.8 };
    }

    const body = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = body.choices?.[0]?.message?.content?.trim();
    if (!raw) return { source: "fallback", continue: Math.random() < 0.8 };

    const parsed = JSON.parse(raw) as { continue?: boolean; reason?: string };
    const shouldContinue = parsed.continue === true;
    const reason = parsed.reason ? String(parsed.reason) : undefined;
    logger.info("GROQ", `Chain → ${shouldContinue ? "continue" : "pause"} (${reason ?? ""})`);
    return { source: "groq", continue: shouldContinue, reason };
  } catch (err) {
    logger.warn("GROQ", `Chain decision failed: ${(err as Error).message}`);
    return { source: "fallback", continue: Math.random() < 0.8 };
  } finally {
    clearTimeout(timer);
  }
}
