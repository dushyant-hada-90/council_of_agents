import { agentNamesMatch, findAgentByNameToken, normalizeAgentNameToken } from "./nameMatching";
import {
  generateJsonReply,
  pickSpeakerAndRespond,
  type PickSpeakerAndRespondCandidate,
} from "./google/geminiChat";
import { getEnv } from "../lib/env";
import { logger } from "./logger";


export interface ConversationTurn {
  speaker: string;
  speakerId: string;
  role: "human" | "agent";
  text: string;
}

export type MergedSpeakerPick =
  | {
      source: "gemini";
      kind: "agent";
      agentId: string;
      agentName: string;
      reason?: string;
      response: string;
    }
  | { source: "gemini"; kind: "human"; reason?: string }
  | { source: "random"; kind: "random" };

export interface PickSpeakerAndRespondInput {
  humanName: string;
  turns: ConversationTurn[];
  candidates: PickSpeakerAndRespondCandidate[];
  lastSpeakerId?: string;
  recentSpeakerIds?: string[];
  context: "human_turn" | "chain";
  scenarioHint: string;
  timeoutMs?: number;
}

export type ChainContinueDecision =
  | { source: "gemini"; continue: boolean; reason?: string }
  | { source: "fallback"; continue: boolean };

export interface ShouldContinueChainInput {
  humanName: string;
  turns: ConversationTurn[];
  chainTurnCount: number;
  lastSpeakerName: string;
  lastTranscript: string;
  addresseeKind: "human" | "everyone" | "agent";
  addresseeName?: string;
  timeoutMs?: number;
}

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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

function resolveSpeakerName(
  next: string,
  humanName: string,
  candidates: Array<{ id: string; name: string }>
): { kind: "human" } | { kind: "random" } | { kind: "agent"; agentId: string; agentName: string } {
  if (/^random$/i.test(next)) {
    return { kind: "random" };
  }

  if (isHumanSpeakerPick(next, humanName)) {
    return { kind: "human" };
  }

  const byExact = candidates.find(
    (c) => c.name.toLowerCase() === next.toLowerCase() || agentNamesMatch(next, c.name)
  );
  if (byExact) {
    return { kind: "agent", agentId: byExact.id, agentName: byExact.name };
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
    return { kind: "agent", agentId: byPartial.id, agentName: byPartial.name };
  }

  return { kind: "random" };
}

export async function pickSpeakerAndRespondWithGemini(
  input: PickSpeakerAndRespondInput
): Promise<MergedSpeakerPick> {
  const { humanName, turns, candidates, lastSpeakerId, recentSpeakerIds, context, scenarioHint } =
    input;
  const timeoutMs = input.timeoutMs ?? getEnv().GEMINI_MERGED_TURN_TIMEOUT_MS;
  const human = humanName.trim() || "You";
  const fallback: MergedSpeakerPick = { source: "random", kind: "random" };

  if (candidates.length === 0) {
    return fallback;
  }

  const lastSpeakerName = lastSpeakerId
    ? candidates.find((c) => c.id === lastSpeakerId)?.name
    : undefined;
  const recentSpeakerNames =
    recentSpeakerIds
      ?.map((id) => candidates.find((c) => c.id === id)?.name)
      .filter((n): n is string => Boolean(n)) ?? [];
  const conversationLines = turns
    .slice(-14)
    .map((t) => `${t.speaker}: ${t.text}`)
    .join("\n");

  try {
    const parsed = await withTimeout(
      pickSpeakerAndRespond({
        humanName: human,
        conversationLines,
        candidates,
        context,
        scenarioHint,
        lastSpeakerName,
        recentSpeakerNames,
      }),
      timeoutMs,
      {}
    );

    const next = String(parsed.next ?? "").trim();
    const reason = parsed.reason ? String(parsed.reason) : undefined;
    const response = String(parsed.response ?? "").trim();
    const resolved = resolveSpeakerName(
      next,
      human,
      candidates.map((c) => ({ id: c.id, name: c.name }))
    );

    if (resolved.kind === "random") {
      logger.warn("GEMINI", `Merged turn → random (${reason ?? (next || "open floor")})`);
      return { source: "random", kind: "random" };
    }

    if (resolved.kind === "human") {
      logger.info("GEMINI", `Merged turn → ${human} (${reason ?? ""})`);
      return { source: "gemini", kind: "human", reason };
    }

    if (!response) {
      logger.warn(
        "GEMINI",
        `Merged turn picked ${resolved.agentName} but response empty — random fallback`
      );
      return { source: "random", kind: "random" };
    }

    logger.info(
      "GEMINI",
      `Merged turn → ${resolved.agentName}: "${response.slice(0, 60)}${response.length > 60 ? "…" : ""}" (${reason ?? ""})`
    );
    return {
      source: "gemini",
      kind: "agent",
      agentId: resolved.agentId,
      agentName: resolved.agentName,
      reason,
      response,
    };
  } catch (err) {
    logger.warn("GEMINI", `Merged turn failed: ${(err as Error).message}`);
    return fallback;
  }
}

export async function shouldContinueChainWithGemini(
  input: ShouldContinueChainInput
): Promise<ChainContinueDecision> {
  const {
    humanName,
    turns,
    chainTurnCount,
    lastSpeakerName,
    lastTranscript,
    addresseeKind,
    addresseeName,
  } = input;
  const human = humanName.trim() || "You";
  const timeoutMs = input.timeoutMs ?? getEnv().GEMINI_ROUTING_TIMEOUT_MS;

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

Continue the chain when there is unresolved disagreement or an open challenge.
Stop when the point feels settled or it is time to invite ${human} back.

Reply with JSON only: {"continue":true|false,"reason":"<max 12 words>"}`;

  const user = `Recent conversation:\n${recent || "(empty)"}\n\nLast line from ${lastSpeakerName}: "${lastTranscript}"\n\nShould another agent react?`;

  const fallback: ChainContinueDecision = {
    source: "fallback",
    continue: Math.random() < 0.8,
  };

  try {
    const parsed = await withTimeout(
      generateJsonReply(system, user, getEnv().GEMINI_ROUTING_MODEL),
      timeoutMs,
      {}
    );

    const shouldContinue = parsed.continue === true;
    const reason = parsed.reason ? String(parsed.reason) : undefined;
    logger.info("GEMINI", `Chain → ${shouldContinue ? "continue" : "pause"} (${reason ?? ""})`);
    return { source: "gemini", continue: shouldContinue, reason };
  } catch (err) {
    logger.warn("GEMINI", `Chain decision failed: ${(err as Error).message}`);
    return fallback;
  }
}
