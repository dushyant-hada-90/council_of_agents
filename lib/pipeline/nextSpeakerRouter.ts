import { agentNamesMatch, findAgentByNameToken, normalizeAgentNameToken } from "@/lib/helpers/nameMatching";
import {
  generateJsonReply,
  pickSpeakerAndRespond,
  type PickSpeakerAndRespondCandidate,
} from "./geminiChat";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

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
  | { source: "failed"; kind: "invalid"; reason?: string };

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

const MERGED_TURN_MAX_ATTEMPTS = 2;

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

async function withTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await factory(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) return fallback;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function resolveSpeakerName(
  next: string,
  humanName: string,
  candidates: Array<{ id: string; name: string }>
): { kind: "human" } | { kind: "invalid"; raw: string } | { kind: "agent"; agentId: string; agentName: string } {
  if (/^random$/i.test(next.trim())) {
    return { kind: "invalid", raw: next };
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

  return { kind: "invalid", raw: next };
}

function parseMergedTurnResult(
  parsed: Record<string, unknown>,
  human: string,
  context: PickSpeakerAndRespondInput["context"],
  candidates: PickSpeakerAndRespondCandidate[]
): MergedSpeakerPick {
  const next = String(parsed.next ?? "").trim();
  const reason = parsed.reason ? String(parsed.reason) : undefined;
  const response = String(parsed.response ?? "").trim();

  if (!next) {
    return { source: "failed", kind: "invalid", reason: "empty next" };
  }

  const resolved = resolveSpeakerName(
    next,
    human,
    candidates.map((c) => ({ id: c.id, name: c.name }))
  );

  if (resolved.kind === "invalid") {
    logger.warn("GEMINI", `Merged turn invalid next="${resolved.raw}" (${reason ?? ""})`);
    return { source: "failed", kind: "invalid", reason: reason ?? `invalid next: ${resolved.raw}` };
  }

  if (resolved.kind === "human") {
    if (context === "human_turn") {
      logger.warn(
        "GEMINI",
        `Merged turn rejected human handoff on human_turn (next="${next}"${reason ? `, reason="${reason}"` : ""})`
      );
      return { source: "failed", kind: "invalid", reason: "human handoff on human_turn" };
    }
    logger.info("GEMINI", `Merged turn → ${human} (${reason ?? ""})`);
    return { source: "gemini", kind: "human", reason };
  }

  if (!response) {
    logger.warn("GEMINI", `Merged turn picked ${resolved.agentName} but response empty`);
    return { source: "failed", kind: "invalid", reason: "empty response" };
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
}

async function attemptMergedTurn(
  input: PickSpeakerAndRespondInput,
  attempt: number
): Promise<MergedSpeakerPick> {
  const { humanName, turns, candidates, lastSpeakerId, recentSpeakerIds, context, scenarioHint } =
    input;
  const timeoutMs = input.timeoutMs ?? getEnv().GEMINI_MERGED_TURN_TIMEOUT_MS;
  const human = humanName.trim() || "You";

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

  if (attempt > 1) {
    logger.info("GEMINI", `Merged turn retry attempt ${attempt}/${MERGED_TURN_MAX_ATTEMPTS}`);
  }

  const parsed = await withTimeout(
    (signal) =>
      pickSpeakerAndRespond({
        humanName: human,
        conversationLines,
        candidates,
        context,
        scenarioHint,
        lastSpeakerName,
        recentSpeakerNames,
        signal,
      }),
    timeoutMs,
    {}
  );

  if (!parsed || typeof parsed !== "object" || !("next" in parsed)) {
    return { source: "failed", kind: "invalid", reason: "timeout or empty payload" };
  }

  return parseMergedTurnResult(parsed as Record<string, unknown>, human, context, candidates);
}

export async function pickSpeakerAndRespondWithGemini(
  input: PickSpeakerAndRespondInput
): Promise<MergedSpeakerPick> {
  if (input.candidates.length === 0) {
    return { source: "failed", kind: "invalid", reason: "no candidates" };
  }

  let lastFailure: MergedSpeakerPick = { source: "failed", kind: "invalid", reason: "unknown" };

  for (let attempt = 1; attempt <= MERGED_TURN_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await attemptMergedTurn(input, attempt);
      if (result.source === "gemini") {
        return result;
      }
      lastFailure = result;
    } catch (err) {
      lastFailure = {
        source: "failed",
        kind: "invalid",
        reason: (err as Error).message,
      };
      logger.warn("GEMINI", `Merged turn attempt ${attempt} failed: ${(err as Error).message}`);
    }
  }

  return lastFailure;
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
      (signal) => generateJsonReply(system, user, undefined, signal),
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
