import { agentNamesMatch, findAgentByNameToken, normalizeAgentNameToken } from "@/lib/helpers/nameMatching";
import { type LiveMeetingMetadata } from "@/lib/prompts/prompts";
import {
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
  | { source: "gemini"; kind: "pause"; reason?: string; handoff: string }
  | { source: "failed"; kind: "invalid"; reason?: string };

export interface PickSpeakerAndRespondInput {
  humanName: string;
  turns: ConversationTurn[];
  candidates: PickSpeakerAndRespondCandidate[];
  meetingMetadata: LiveMeetingMetadata;
  afterHuman: boolean;
  handoffOnly?: boolean;
  lastSpeakerId?: string;
  lastTranscript?: string;
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
  onTimeout: T
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await factory(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) return onTimeout;
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

function parseHandoffResult(parsed: Record<string, unknown>): MergedSpeakerPick {
  const handoff = String(parsed.handoff ?? "").trim();
  if (!handoff) {
    return { source: "failed", kind: "invalid", reason: "empty handoff" };
  }
  logger.info("GEMINI", `Handoff line: "${handoff.slice(0, 60)}${handoff.length > 60 ? "…" : ""}"`);
  return { source: "gemini", kind: "pause", handoff };
}

function parseMergedTurnResult(
  parsed: Record<string, unknown>,
  human: string,
  afterHuman: boolean,
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
    if (afterHuman) {
      logger.warn(
        "GEMINI",
        `Merged turn rejected human handoff after human spoke (next="${next}"${reason ? `, reason="${reason}"` : ""})`
      );
      return { source: "failed", kind: "invalid", reason: "human handoff after human spoke" };
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

function parseChainTurnResult(
  parsed: Record<string, unknown>,
  human: string,
  candidates: PickSpeakerAndRespondCandidate[]
): MergedSpeakerPick {
  if ("handoff" in parsed) {
    return parseHandoffResult(parsed);
  }
  if ("next" in parsed) {
    return parseMergedTurnResult(parsed, human, false, candidates);
  }
  return { source: "failed", kind: "invalid", reason: "missing next or handoff" };
}

async function attemptMergedTurn(
  input: PickSpeakerAndRespondInput,
  attempt: number
): Promise<MergedSpeakerPick> {
  const {
    humanName,
    turns,
    candidates,
    meetingMetadata,
    afterHuman,
    handoffOnly,
    lastSpeakerId,
    lastTranscript,
  } = input;
  const timeoutMs = input.timeoutMs ?? getEnv().GEMINI_MERGED_TURN_TIMEOUT_MS;
  const human = humanName.trim() || "You";

  const lastSpeakerName = lastSpeakerId
    ? candidates.find((c) => c.id === lastSpeakerId)?.name
    : undefined;
  const chatTranscript = turns.map((t) => `${t.speaker}: ${t.text}`).join("\n");

  if (attempt > 1) {
    logger.info("GEMINI", `Merged turn retry attempt ${attempt}/${MERGED_TURN_MAX_ATTEMPTS}`);
  }

  const parsed = await withTimeout(
    (signal) =>
      pickSpeakerAndRespond({
        humanName: human,
        chatTranscript,
        candidates,
        meetingMetadata,
        afterHuman,
        handoffOnly,
        lastSpeakerName,
        lastTranscript,
        signal,
      }),
    timeoutMs,
    {}
  );

  if (!parsed || typeof parsed !== "object") {
    return { source: "failed", kind: "invalid", reason: "timeout or empty payload" };
  }

  if (handoffOnly) {
    if (!("handoff" in parsed)) {
      return { source: "failed", kind: "invalid", reason: "timeout or empty handoff payload" };
    }
    return parseHandoffResult(parsed as Record<string, unknown>);
  }

  if (afterHuman) {
    if (!("next" in parsed)) {
      return { source: "failed", kind: "invalid", reason: "timeout or empty payload" };
    }
    return parseMergedTurnResult(parsed as Record<string, unknown>, human, true, candidates);
  }

  return parseChainTurnResult(parsed as Record<string, unknown>, human, candidates);
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

export async function requestHandoffWithGemini(input: {
  humanName: string;
  turns: ConversationTurn[];
  candidates: PickSpeakerAndRespondCandidate[];
  meetingMetadata: LiveMeetingMetadata;
  lastSpeakerId: string;
  lastTranscript?: string;
  timeoutMs?: number;
}): Promise<MergedSpeakerPick> {
  return pickSpeakerAndRespondWithGemini({
    humanName: input.humanName,
    turns: input.turns,
    candidates: input.candidates,
    meetingMetadata: input.meetingMetadata,
    afterHuman: false,
    handoffOnly: true,
    lastSpeakerId: input.lastSpeakerId,
    lastTranscript: input.lastTranscript,
    timeoutMs: input.timeoutMs,
  });
}
