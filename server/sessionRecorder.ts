import fs from "fs";
import path from "path";
import type { PipelineHooks } from "./agentSession";
import { InterruptPlaybackReport } from "./conferenceTypes";
import { logger } from "../lib/logger";
import { PCM16_BYTES_PER_MS } from "./agentSession";

// ─── Core timeline event ──────────────────────────────────────────────────────

export interface TimelineEvent {
  /** Monotonically increasing sequence number within the session. */
  seq: number;
  /** What happened. */
  event: string;
  /** Wall-clock epoch ms when this event was recorded. */
  at: number;
  /** ms elapsed since session start (for quick visual scanning). */
  relMs: number;
  agentId?: string;
  agentName?: string;
  /** Any additional diagnostic data specific to the event. */
  data?: Record<string, unknown>;
}

// ─── Human PTT turn ───────────────────────────────────────────────────────────

export interface HumanTurnRecord {
  /** 0-based index across the whole session. */
  index: number;

  // Push-to-talk window
  pttStartAt: number;
  pttEndAt: number | null;
  pttDurationMs: number | null;
  audioChunks: number;
  audioBytes: number;
  /** Estimated PTT audio length (from byte count). */
  audioDurationMs: number | null;

  // STT pipeline
  sttSubmitAt: number | null;
  sttResultAt: number | null;
  sttDurationMs: number | null;
  sttSource: "google" | "none" | "error" | null;
  sttText: string | null;
  sttDetail: string | null;
  /** True if the 10-second fallback timer fired before STT returned. */
  sttTimedOut: boolean;

  // Routing (merged Gemini pick-and-respond call)
  routingStartAt: number | null;
  routingEndAt: number | null;
  routingDurationMs: number | null;
  /** How the next speaker was resolved. */
  routingMethod: "merged_gemini" | "server_fallback" | null;
  selectedAgentId: string | null;
  selectedAgentName: string | null;
  routingReason: string | null;
  /** True when the routing call also pre-generated the agent reply. */
  preGeneratedResponse: boolean | null;
}

// ─── Agent spoken turn ────────────────────────────────────────────────────────

export interface AgentTurnRecord {
  /** 0-based index across the whole session. */
  index: number;
  /** Which human PTT turn triggered this (directly or via chain). */
  humanTurnIndex: number | null;
  context: "human_turn" | "chain" | "engagement";
  agentId: string;
  agentName: string;

  /** When triggerResponse() was called — start of the agent's clock. */
  triggerAt: number;
  /** True when the routing call already supplied the spoken text. */
  preGenerated: boolean;

  // Gemini chat (only when not pre-generated)
  geminiStartAt: number | null;
  geminiEndAt: number | null;
  geminiMs: number | null;

  // Generated text
  responseText: string | null;
  responseWords: number | null;
  responseChars: number | null;

  // TTS synthesis
  ttsStartAt: number | null;
  ttsEndAt: number | null;
  ttsMs: number | null;
  audioPcmBytes: number | null;
  audioDurationMs: number | null;

  // WebSocket delivery
  /** When server sent the FIRST audio chunk to the client. */
  firstDeltaSentAt: number | null;
  /** When server sent the LAST audio chunk to the client. */
  lastDeltaSentAt: number | null;
  /** lastDelta - firstDelta: time to stream all chunks over WS. */
  deltaStreamMs: number | null;

  // Estimated client playout
  // The client queues audio; for the first agent after a human turn, playout starts
  // almost immediately. For chain agents, earlier agents may still be playing.
  /** Estimated epoch ms when the user starts hearing this turn. */
  estimatedPlayoutStart: number | null;
  /** Estimated epoch ms when the user finishes hearing this turn. */
  estimatedPlayoutEnd: number | null;
  /** How long this turn waited in the client queue before playing (0 for first). */
  estimatedQueueDelayMs: number | null;

  // Key latency metrics
  /** firstDeltaSentAt - triggerAt: latency from agent selection to first audio on wire. */
  triggerToFirstDeltaMs: number | null;
  /** firstDeltaSentAt - pttEndAt: full perceived latency (only for first agent on human_turn). */
  pttEndToFirstDeltaMs: number | null;

  status: "in_progress" | "completed" | "cancelled" | "failed";
}

// ─── Legacy record types (kept for backward compat) ──────────────────────────

export interface TurnRecord {
  timestamp: number;
  speakerId: string;
  speaker: string;
  role: "human" | "agent";
  text: string;
  partial?: boolean;
  addressee?: { kind: string; name?: string };
  replyTo?: { kind: string; name: string };
  routingReason?: string;
  routingSource?: "gemini" | "server_fallback" | "engagement";
}

export interface RoutingRecord {
  timestamp: number;
  context: "human_turn" | "chain" | "engagement";
  selectedSpeakerId: string;
  selectedSpeaker: string;
  source: "gemini" | "server_fallback" | "human_handoff" | "engagement";
  reason?: string;
  label: string;
}

export interface RollbackAction {
  agentId: string;
  agentName: string;
  mode: "delete" | "truncate";
  audioEndMs?: number;
}

export interface InterruptRecord {
  timestamp: number;
  playoutEpoch: number;
  interruptedBy: "human";
  activeAgentId: string | null;
  activeAgentName: string | null;
  playbackReport: InterruptPlaybackReport | null;
  rollback: RollbackAction[];
  agentsCompletedThisRound: string[];
}

export interface ChainRecord {
  timestamp: number;
  afterSpeakerId: string;
  afterSpeaker: string;
  afterTranscript: string;
  chainTurnCount: number;
  addresseeKind: "human" | "everyone" | "agent";
  addresseeName?: string;
  decision: "continue" | "pause";
  source: "gemini" | "fallback" | "first_guaranteed" | "safety_cap";
  reason?: string;
}

// ─── Session artifact ─────────────────────────────────────────────────────────

export interface SessionMetrics {
  totalHumanTurns: number;
  totalAgentTurns: number;
  totalInterrupts: number;
  totalChainTurns: number;

  stt: {
    successRate: number;
    timedOutCount: number;
    avgDurationMs: number | null;
    minDurationMs: number | null;
    maxDurationMs: number | null;
  };

  routing: {
    avgDurationMs: number | null;
    geminiRate: number;
    serverFallbackRate: number;
    preGeneratedRate: number;
  };

  gemini: {
    avgDurationMs: number | null;
    minDurationMs: number | null;
    maxDurationMs: number | null;
  };

  tts: {
    avgDurationMs: number | null;
    minDurationMs: number | null;
    maxDurationMs: number | null;
  };

  /** End-to-end: PTT release → first audio byte sent to client (after each human turn). */
  e2eLatency: {
    count: number;
    minMs: number | null;
    maxMs: number | null;
    medianMs: number | null;
    p90Ms: number | null;
    avgMs: number | null;
  };

  /** Breakdown per agent. */
  byAgent: Record<
    string,
    {
      agentName: string;
      turns: number;
      avgGeminiMs: number | null;
      avgTtsMs: number | null;
      avgTriggerToFirstDeltaMs: number | null;
    }
  >;
}

export interface SessionArtifact {
  meetingId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  participants: { human: string; agents: Array<{ id: string; name: string }> };

  /** Flat chronological event log — every instrumented event in order. */
  timeline: TimelineEvent[];

  /** One record per human PTT turn with full STT + routing breakdown. */
  humanTurns: HumanTurnRecord[];

  /** One record per agent spoken turn with full pipeline breakdown. */
  agentTurns: AgentTurnRecord[];

  /** Aggregated performance metrics for the whole session. */
  metrics: SessionMetrics;

  /** Legacy fields — retained for backward compat. */
  turns: TurnRecord[];
  routing: RoutingRecord[];
  interrupts: InterruptRecord[];
  chains: ChainRecord[];
}

// ─── Directory resolution ─────────────────────────────────────────────────────

function resolveSessionsDir(): string {
  const envDir = process.env["SESSION_RECORDINGS_DIR"];
  if (envDir && envDir.trim()) return envDir.trim();
  const root = __dirname.includes(`${path.sep}dist${path.sep}`)
    ? path.resolve(__dirname, "../..")
    : path.resolve(__dirname, "..");
  return path.join(root, "sessions");
}

// ─── SessionRecorder ──────────────────────────────────────────────────────────

export class SessionRecorder {
  private readonly meetingId: string;
  private readonly startedAt = Date.now();
  private readonly participants: SessionArtifact["participants"];

  // New rich tracking
  private readonly timeline: TimelineEvent[] = [];
  private readonly humanTurns: HumanTurnRecord[] = [];
  private readonly agentTurns: AgentTurnRecord[] = [];
  private seqCounter = 0;

  // Running state
  private currentHumanTurnIndex: number | null = null;
  /** Estimated epoch ms when the current audio queue will finish playing. */
  private playoutQueueEndAt: number | null = null;
  private pendingPttStart: number | null = null;

  // Legacy tracking
  private readonly turns: TurnRecord[] = [];
  private readonly routing: RoutingRecord[] = [];
  private readonly interrupts: InterruptRecord[] = [];
  private readonly chains: ChainRecord[] = [];
  private pendingRouting: RoutingRecord | null = null;
  private latencyPending: {
    pttEndAt: number;
    winnerId: string | null;
    winnerName: string | null;
    recorded: boolean;
  } | null = null;

  constructor(
    meetingId: string,
    agentMeta: Array<{ id: string; name: string }>,
    humanName = "You"
  ) {
    this.meetingId = meetingId;
    this.participants = {
      human: humanName,
      agents: agentMeta.map((a) => ({ id: a.id, name: a.name })),
    };
    this.addEvent("session_start", { meetingId });
  }

  // ─── Timeline helpers ───────────────────────────────────────────────────────

  private addEvent(
    event: string,
    data?: Record<string, unknown>,
    agentId?: string,
    agentName?: string
  ): TimelineEvent {
    const ev: TimelineEvent = {
      seq: this.seqCounter++,
      event,
      at: Date.now(),
      relMs: Date.now() - this.startedAt,
      agentId,
      agentName,
      data,
    };
    this.timeline.push(ev);
    return ev;
  }

  private currentHumanTurn(): HumanTurnRecord | null {
    if (this.currentHumanTurnIndex === null) return null;
    return this.humanTurns[this.currentHumanTurnIndex] ?? null;
  }

  // ─── PTT / Human turn ──────────────────────────────────────────────────────

  /** Called when START_SPEECH is received — human presses PTT. */
  markPttStart(): void {
    const now = Date.now();
    this.pendingPttStart = now;

    const record: HumanTurnRecord = {
      index: this.humanTurns.length,
      pttStartAt: now,
      pttEndAt: null,
      pttDurationMs: null,
      audioChunks: 0,
      audioBytes: 0,
      audioDurationMs: null,
      sttSubmitAt: null,
      sttResultAt: null,
      sttDurationMs: null,
      sttSource: null,
      sttText: null,
      sttDetail: null,
      sttTimedOut: false,
      routingStartAt: null,
      routingEndAt: null,
      routingDurationMs: null,
      routingMethod: null,
      selectedAgentId: null,
      selectedAgentName: null,
      routingReason: null,
      preGeneratedResponse: null,
    };
    this.humanTurns.push(record);
    this.currentHumanTurnIndex = record.index;
    this.addEvent("ptt_start");
  }

  /** Called on END_SPEECH — human releases PTT. Also resets playout queue. */
  markPttEnd(audioChunks: number, audioBytes: number): void {
    const now = Date.now();
    // Interrupt resets the queue
    this.playoutQueueEndAt = now;

    const rec = this.currentHumanTurn();
    if (rec) {
      rec.pttEndAt = now;
      rec.pttDurationMs = rec.pttStartAt ? now - rec.pttStartAt : null;
      rec.audioChunks = audioChunks;
      rec.audioBytes = audioBytes;
      rec.audioDurationMs = audioBytes > 0 ? Math.round(audioBytes / PCM16_BYTES_PER_MS) : null;
    }
    this.addEvent("ptt_end", {
      audioChunks,
      audioBytes,
      pttDurationMs: rec?.pttDurationMs ?? null,
    });

    // Legacy
    this.markHumanPttEnd();
  }

  /** Called immediately before the audio is submitted to Google STT. */
  markSttSubmit(): void {
    const now = Date.now();
    const rec = this.currentHumanTurn();
    if (rec) rec.sttSubmitAt = now;
    this.addEvent("stt_submit");
  }

  /** Called when Google STT returns (text or empty). */
  markSttResult(
    text: string | null,
    source: "google" | "none" | "error",
    detail: string
  ): void {
    const now = Date.now();
    const rec = this.currentHumanTurn();
    if (rec) {
      rec.sttResultAt = now;
      rec.sttDurationMs = rec.sttSubmitAt ? now - rec.sttSubmitAt : null;
      rec.sttSource = source;
      rec.sttText = text;
      rec.sttDetail = detail;
    }
    this.addEvent("stt_result", {
      source,
      text: text ? `${text.slice(0, 80)}${text.length > 80 ? "…" : ""}` : null,
      detail,
      sttDurationMs: rec?.sttDurationMs ?? null,
    });
  }

  /** Called when the transcript fallback timer fires (STT too slow or silent). */
  markSttTimedOut(): void {
    const rec = this.currentHumanTurn();
    if (rec) rec.sttTimedOut = true;
    this.addEvent("stt_fallback_fired", { timeoutMs: rec?.sttSubmitAt
      ? Date.now() - rec.sttSubmitAt
      : null });
  }

  // ─── Routing ───────────────────────────────────────────────────────────────

  /** Called just before the Gemini merged routing+response call. */
  markRoutingStart(context: "human_turn" | "chain"): void {
    const rec = this.currentHumanTurn();
    if (rec && context === "human_turn") rec.routingStartAt = Date.now();
    this.addEvent("routing_start", { context });
  }

  /** Called after the routing result is resolved (before triggerResponse). */
  markRoutingResult(
    agentId: string,
    agentName: string,
    method: "merged_gemini" | "server_fallback",
    reason: string | undefined,
    preGenerated: boolean
  ): void {
    const now = Date.now();
    const rec = this.currentHumanTurn();
    if (rec) {
      rec.routingEndAt = now;
      rec.routingDurationMs = rec.routingStartAt ? now - rec.routingStartAt : null;
      rec.routingMethod = method;
      rec.selectedAgentId = agentId;
      rec.selectedAgentName = agentName;
      rec.routingReason = reason ?? null;
      rec.preGeneratedResponse = preGenerated;
    }
    this.addEvent(
      "routing_result",
      { method, reason: reason ?? null, preGenerated, routingDurationMs: rec?.routingDurationMs ?? null },
      agentId,
      agentName
    );
  }

  // ─── Agent turn ────────────────────────────────────────────────────────────

  /**
   * Called at the start of each agent turn (just before triggerResponse).
   * Returns PipelineHooks that PipelineAgentSession calls during runPipeline.
   */
  beginAgentTurn(
    agentId: string,
    agentName: string,
    context: "human_turn" | "chain" | "engagement",
    preGenerated: boolean
  ): PipelineHooks {
    const now = Date.now();
    const humanTurnIndex = context === "human_turn" ? (this.currentHumanTurnIndex ?? null) : null;
    const pttEndAt = humanTurnIndex !== null
      ? (this.humanTurns[humanTurnIndex]?.pttEndAt ?? null)
      : null;

    const record: AgentTurnRecord = {
      index: this.agentTurns.length,
      humanTurnIndex,
      context,
      agentId,
      agentName,
      triggerAt: now,
      preGenerated,
      geminiStartAt: null,
      geminiEndAt: null,
      geminiMs: null,
      responseText: null,
      responseWords: null,
      responseChars: null,
      ttsStartAt: null,
      ttsEndAt: null,
      ttsMs: null,
      audioPcmBytes: null,
      audioDurationMs: null,
      firstDeltaSentAt: null,
      lastDeltaSentAt: null,
      deltaStreamMs: null,
      estimatedPlayoutStart: null,
      estimatedPlayoutEnd: null,
      estimatedQueueDelayMs: null,
      triggerToFirstDeltaMs: null,
      pttEndToFirstDeltaMs: null,
      status: "in_progress",
    };
    this.agentTurns.push(record);

    this.addEvent("agent_triggered", { context, preGenerated, humanTurnIndex }, agentId, agentName);

    const self = this;

    return {
      onGeminiStart(): void {
        record.geminiStartAt = Date.now();
        self.addEvent("gemini_start", {}, agentId, agentName);
      },

      onGeminiEnd(text: string): void {
        const t = Date.now();
        record.geminiEndAt = t;
        record.geminiMs = record.geminiStartAt ? t - record.geminiStartAt : null;
        record.responseText = text;
        record.responseWords = text.split(/\s+/).filter(Boolean).length;
        record.responseChars = text.length;
        self.addEvent(
          "gemini_result",
          {
            geminiMs: record.geminiMs,
            words: record.responseWords,
            preview: `${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
          },
          agentId,
          agentName
        );
      },

      onTtsStart(): void {
        record.ttsStartAt = Date.now();
        self.addEvent("tts_start", {}, agentId, agentName);
      },

      onTtsEnd(pcmBytes: number): void {
        const t = Date.now();
        record.ttsEndAt = t;
        record.ttsMs = record.ttsStartAt ? t - record.ttsStartAt : null;
        record.audioPcmBytes = pcmBytes;
        record.audioDurationMs = pcmBytes > 0 ? Math.round(pcmBytes / PCM16_BYTES_PER_MS) : 0;
        self.addEvent(
          "tts_result",
          {
            ttsMs: record.ttsMs,
            pcmBytes,
            audioDurationMs: record.audioDurationMs,
          },
          agentId,
          agentName
        );
      },

      onFirstAudioSent(): void {
        const t = Date.now();
        record.firstDeltaSentAt = t;
        record.triggerToFirstDeltaMs = t - record.triggerAt;
        record.pttEndToFirstDeltaMs = pttEndAt && context === "human_turn" ? t - pttEndAt : null;

        // Estimated client playout — account for queue
        const queueEnd = self.playoutQueueEndAt ?? t;
        const playStart = Math.max(t, queueEnd);
        record.estimatedPlayoutStart = playStart;
        record.estimatedQueueDelayMs = playStart - t;

        self.addEvent(
          "first_audio_sent",
          {
            triggerToFirstDeltaMs: record.triggerToFirstDeltaMs,
            pttEndToFirstDeltaMs: record.pttEndToFirstDeltaMs,
            estimatedQueueDelayMs: record.estimatedQueueDelayMs,
          },
          agentId,
          agentName
        );

        // Legacy latency recording
        if (self.latencyPending && !self.latencyPending.recorded) {
          if (!self.latencyPending.winnerId || self.latencyPending.winnerId === agentId) {
            const latencyMs = t - self.latencyPending.pttEndAt;
            self.latencyPending.recorded = true;
            logger.info("RECORDER", `E2E latency: ${latencyMs}ms → ${agentName}`);
          }
        }
      },

      onLastAudioSent(): void {
        const t = Date.now();
        record.lastDeltaSentAt = t;
        record.deltaStreamMs = record.firstDeltaSentAt ? t - record.firstDeltaSentAt : null;

        // Finalize estimated playout end
        const playStart = record.estimatedPlayoutStart ?? t;
        const audioDur = record.audioDurationMs ?? 0;
        record.estimatedPlayoutEnd = playStart + audioDur;
        self.playoutQueueEndAt = record.estimatedPlayoutEnd;

        self.addEvent(
          "last_audio_sent",
          {
            deltaStreamMs: record.deltaStreamMs,
            estimatedPlayoutEnd: record.estimatedPlayoutEnd,
          },
          agentId,
          agentName
        );
      },

      onDone(status: "completed" | "cancelled" | "failed"): void {
        record.status = status;
        self.addEvent("agent_done", { status }, agentId, agentName);
      },
    };
  }

  // ─── Legacy API ────────────────────────────────────────────────────────────

  recordRouting(entry: Omit<RoutingRecord, "timestamp">): void {
    const record: RoutingRecord = { ...entry, timestamp: Date.now() };
    this.routing.push(record);
    if (entry.selectedSpeakerId !== "human") {
      this.pendingRouting = record;
    }
  }

  recordTurn(
    entry: Omit<TurnRecord, "timestamp" | "routingReason" | "routingSource"> & {
      routingReason?: string;
      routingSource?: TurnRecord["routingSource"];
    }
  ): void {
    let routingReason = entry.routingReason;
    let routingSource = entry.routingSource;

    if (
      entry.role === "agent" &&
      this.pendingRouting &&
      this.pendingRouting.selectedSpeakerId === entry.speakerId
    ) {
      routingReason = routingReason ?? this.pendingRouting.reason ?? this.pendingRouting.label;
      const src = this.pendingRouting.source;
      if (src !== "human_handoff") {
        routingSource = routingSource ?? src;
      }
      this.pendingRouting = null;
    }

    this.turns.push({ ...entry, timestamp: Date.now(), routingReason, routingSource });
  }

  recordInterrupt(entry: Omit<InterruptRecord, "timestamp">): void {
    this.interrupts.push({ ...entry, timestamp: Date.now() });
    this.pendingRouting = null;
    this.playoutQueueEndAt = Date.now();
    this.addEvent("interrupt", {
      playoutEpoch: entry.playoutEpoch,
      activeAgent: entry.activeAgentName,
      fullyHeard: entry.playbackReport?.fullyHeard,
      unheard: entry.playbackReport?.unheard,
    });
  }

  recordChain(entry: Omit<ChainRecord, "timestamp">): void {
    this.chains.push({ ...entry, timestamp: Date.now() });
  }

  markHumanPttEnd(): void {
    this.latencyPending = {
      pttEndAt: Date.now(),
      winnerId: null,
      winnerName: null,
      recorded: false,
    };
  }

  setLatencyWinner(agentId: string, agentName: string): void {
    if (this.latencyPending && !this.latencyPending.recorded) {
      this.latencyPending.winnerId = agentId;
      this.latencyPending.winnerName = agentName;
    }
  }

  /** Legacy: kept for audioDelta events from orchestrator. */
  recordFirstAudioDelta(agentId: string): void {
    if (!this.latencyPending || this.latencyPending.recorded) return;
    if (this.latencyPending.winnerId && this.latencyPending.winnerId !== agentId) return;
    // Actual recording happens in onFirstAudioSent hook; just mark legacy as recorded.
    this.latencyPending.recorded = true;
  }

  // ─── Metrics computation ───────────────────────────────────────────────────

  private buildMetrics(): SessionMetrics {
    const avg = (nums: number[]) =>
      nums.length === 0 ? null : Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
    const min = (nums: number[]) => (nums.length === 0 ? null : Math.min(...nums));
    const max = (nums: number[]) => (nums.length === 0 ? null : Math.max(...nums));
    const percentile = (sorted: number[], p: number) => {
      if (sorted.length === 0) return null;
      const idx = Math.floor((p / 100) * (sorted.length - 1));
      return sorted[idx] ?? null;
    };

    // STT
    const sttAttempts = this.humanTurns.filter((h) => h.sttSubmitAt !== null);
    const sttSuccesses = sttAttempts.filter((h) => h.sttText);
    const sttDurations = sttAttempts
      .map((h) => h.sttDurationMs)
      .filter((v): v is number => v !== null);
    const sttTimedOutCount = this.humanTurns.filter((h) => h.sttTimedOut).length;

    // Routing
    const routedTurns = this.humanTurns.filter((h) => h.routingEndAt !== null);
    const routingDurations = routedTurns
      .map((h) => h.routingDurationMs)
      .filter((v): v is number => v !== null);
    const geminiRoutedCount = routedTurns.filter((h) => h.routingMethod === "merged_gemini").length;
    const serverFallbackCount = routedTurns.filter((h) => h.routingMethod === "server_fallback").length;
    const preGenCount = routedTurns.filter((h) => h.preGeneratedResponse === true).length;

    // Gemini (separate chat calls only)
    const geminiCalls = this.agentTurns
      .map((a) => a.geminiMs)
      .filter((v): v is number => v !== null);

    // TTS
    const ttsCalls = this.agentTurns.map((a) => a.ttsMs).filter((v): v is number => v !== null);

    // E2E latency (PTT end → first audio to client, human_turn context only)
    const e2eValues = this.agentTurns
      .filter((a) => a.context === "human_turn" && a.pttEndToFirstDeltaMs !== null)
      .map((a) => a.pttEndToFirstDeltaMs!)
      .sort((a, b) => a - b);

    // Per-agent
    const byAgent: SessionMetrics["byAgent"] = {};
    for (const turn of this.agentTurns) {
      if (!byAgent[turn.agentId]) {
        byAgent[turn.agentId] = {
          agentName: turn.agentName,
          turns: 0,
          avgGeminiMs: null,
          avgTtsMs: null,
          avgTriggerToFirstDeltaMs: null,
        };
      }
      const entry = byAgent[turn.agentId]!;
      entry.turns++;
    }
    for (const [agentId, entry] of Object.entries(byAgent)) {
      const turns = this.agentTurns.filter((a) => a.agentId === agentId);
      const gMs = turns.map((a) => a.geminiMs).filter((v): v is number => v !== null);
      const tMs = turns.map((a) => a.ttsMs).filter((v): v is number => v !== null);
      const e2Ms = turns.map((a) => a.triggerToFirstDeltaMs).filter((v): v is number => v !== null);
      entry.avgGeminiMs = avg(gMs);
      entry.avgTtsMs = avg(tMs);
      entry.avgTriggerToFirstDeltaMs = avg(e2Ms);
    }

    return {
      totalHumanTurns: this.humanTurns.length,
      totalAgentTurns: this.agentTurns.length,
      totalInterrupts: this.interrupts.length,
      totalChainTurns: this.agentTurns.filter((a) => a.context === "chain").length,

      stt: {
        successRate: sttAttempts.length ? sttSuccesses.length / sttAttempts.length : 0,
        timedOutCount: sttTimedOutCount,
        avgDurationMs: avg(sttDurations),
        minDurationMs: min(sttDurations),
        maxDurationMs: max(sttDurations),
      },

      routing: {
        avgDurationMs: avg(routingDurations),
        geminiRate: routedTurns.length ? geminiRoutedCount / routedTurns.length : 0,
        serverFallbackRate: routedTurns.length ? serverFallbackCount / routedTurns.length : 0,
        preGeneratedRate: routedTurns.length ? preGenCount / routedTurns.length : 0,
      },

      gemini: {
        avgDurationMs: avg(geminiCalls),
        minDurationMs: min(geminiCalls),
        maxDurationMs: max(geminiCalls),
      },

      tts: {
        avgDurationMs: avg(ttsCalls),
        minDurationMs: min(ttsCalls),
        maxDurationMs: max(ttsCalls),
      },

      e2eLatency: {
        count: e2eValues.length,
        minMs: min(e2eValues),
        maxMs: max(e2eValues),
        medianMs: percentile(e2eValues, 50),
        p90Ms: percentile(e2eValues, 90),
        avgMs: avg(e2eValues),
      },

      byAgent,
    };
  }

  // ─── Flush to disk ─────────────────────────────────────────────────────────

  flush(): string | null {
    const hasContent =
      this.turns.length > 0 ||
      this.humanTurns.length > 0 ||
      this.agentTurns.length > 0 ||
      this.interrupts.length > 0;

    if (!hasContent) return null;

    this.addEvent("session_end");

    const endedAt = Date.now();
    const artifact: SessionArtifact = {
      meetingId: this.meetingId,
      startedAt: this.startedAt,
      endedAt,
      durationMs: endedAt - this.startedAt,
      participants: this.participants,
      timeline: this.timeline,
      humanTurns: this.humanTurns,
      agentTurns: this.agentTurns,
      metrics: this.buildMetrics(),
      turns: this.turns,
      routing: this.routing,
      interrupts: this.interrupts,
      chains: this.chains,
    };

    const dir = resolveSessionsDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      logger.warn("RECORDER", `Failed to create sessions dir "${dir}": ${(err as Error).message}`);
      return null;
    }

    const filename = `session-${this.meetingId}-${this.startedAt}.json`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, JSON.stringify(artifact, null, 2), "utf-8");
    logger.info("RECORDER", `Session artifact → ${filepath} (${this.agentTurns.length} agent turns, e2e avg ${artifact.metrics.e2eLatency.avgMs ?? "n/a"}ms)`);
    return filepath;
  }
}
