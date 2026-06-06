import fs from "fs";
import path from "path";
import { HUMAN_NAME } from "../personalities/agents";
import { InterruptPlaybackReport } from "./conferenceTypes";
import { logger } from "./logger";

// ─── Record types ─────────────────────────────────────────────────────────────

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
  routingSource?: "groq" | "named_fallback" | "random" | "engagement";
}

export interface RoutingRecord {
  timestamp: number;
  context: "human_turn" | "chain" | "engagement";
  selectedSpeakerId: string;
  selectedSpeaker: string;
  source: "groq" | "named_fallback" | "random" | "human_handoff" | "engagement";
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
  source: "groq" | "fallback" | "first_guaranteed" | "safety_cap";
  reason?: string;
}

/** Server-authoritative: END_SPEECH → first audio.delta from routed agent. */
export interface LatencyRecord {
  humanPttEndAt: number;
  firstAudioDeltaAt: number;
  latencyMs: number;
  responderAgentId: string;
  responderAgentName: string;
}

export interface SessionArtifact {
  startedAt: number;
  endedAt: number;
  participants: { human: string; agents: Array<{ id: string; name: string }> };
  turns: TurnRecord[];
  routing: RoutingRecord[];
  interrupts: InterruptRecord[];
  chains: ChainRecord[];
  latencies: LatencyRecord[];
  latencySummary?: {
    count: number;
    medianMs: number;
    minMs: number;
    maxMs: number;
  };
}

// ─── SessionRecorder ──────────────────────────────────────────────────────────

function resolveSessionsDir(): string {
  const root = __dirname.includes(`${path.sep}dist${path.sep}`)
    ? path.resolve(__dirname, "../..")
    : path.resolve(__dirname, "..");
  return process.env["SESSION_RECORDINGS_DIR"] ?? path.join(root, "sessions");
}

export class SessionRecorder {
  private readonly startedAt = Date.now();
  private readonly participants: SessionArtifact["participants"];
  private readonly turns: TurnRecord[] = [];
  private readonly routing: RoutingRecord[] = [];
  private readonly interrupts: InterruptRecord[] = [];
  private readonly chains: ChainRecord[] = [];
  private readonly latencies: LatencyRecord[] = [];
  private pendingRouting: RoutingRecord | null = null;

  private latencyPending: {
    pttEndAt: number;
    winnerId: string | null;
    winnerName: string | null;
    recorded: boolean;
  } | null = null;

  constructor(agentMeta: Array<{ id: string; name: string }>) {
    this.participants = {
      human: HUMAN_NAME,
      agents: agentMeta.map((a) => ({ id: a.id, name: a.name })),
    };
  }

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

    this.turns.push({
      ...entry,
      timestamp: Date.now(),
      routingReason,
      routingSource,
    });
  }

  recordInterrupt(entry: Omit<InterruptRecord, "timestamp">): void {
    this.interrupts.push({ ...entry, timestamp: Date.now() });
    this.pendingRouting = null;
  }

  recordChain(entry: Omit<ChainRecord, "timestamp">): void {
    this.chains.push({ ...entry, timestamp: Date.now() });
  }

  /** END_SPEECH received — start latency window. */
  markHumanPttEnd(): void {
    this.latencyPending = {
      pttEndAt: Date.now(),
      winnerId: null,
      winnerName: null,
      recorded: false,
    };
  }

  /** Agent selected to respond after human PTT — only their first audio.delta counts. */
  setLatencyWinner(agentId: string, agentName: string): void {
    if (this.latencyPending && !this.latencyPending.recorded) {
      this.latencyPending.winnerId = agentId;
      this.latencyPending.winnerName = agentName;
    }
  }

  /** First audio.delta from the routed agent after human PTT. */
  recordFirstAudioDelta(agentId: string): void {
    if (!this.latencyPending || this.latencyPending.recorded) return;
    if (this.latencyPending.winnerId && this.latencyPending.winnerId !== agentId) return;

    const now = Date.now();
    this.latencies.push({
      humanPttEndAt: this.latencyPending.pttEndAt,
      firstAudioDeltaAt: now,
      latencyMs: now - this.latencyPending.pttEndAt,
      responderAgentId: agentId,
      responderAgentName: this.latencyPending.winnerName ?? agentId,
    });
    this.latencyPending.recorded = true;
    logger.info(
      "RECORDER",
      `Latency: ${now - this.latencyPending.pttEndAt} ms → ${this.latencyPending.winnerName ?? agentId}`
    );
  }

  private summarizeLatencies(): SessionArtifact["latencySummary"] | undefined {
    if (this.latencies.length === 0) return undefined;
    const values = this.latencies.map((l) => l.latencyMs).sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    const medianMs =
      values.length % 2 === 0
        ? Math.round((values[mid - 1]! + values[mid]!) / 2)
        : values[mid]!;
    return {
      count: values.length,
      medianMs,
      minMs: values[0]!,
      maxMs: values[values.length - 1]!,
    };
  }

  flush(): string | null {
    const hasContent =
      this.turns.length > 0 ||
      this.interrupts.length > 0 ||
      this.chains.length > 0 ||
      this.routing.length > 0 ||
      this.latencies.length > 0;

    if (!hasContent) return null;

    const artifact: SessionArtifact = {
      startedAt: this.startedAt,
      endedAt: Date.now(),
      participants: this.participants,
      turns: this.turns,
      routing: this.routing,
      interrupts: this.interrupts,
      chains: this.chains,
      latencies: this.latencies,
      latencySummary: this.summarizeLatencies(),
    };

    const dir = resolveSessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const filename = `session-${this.startedAt}.json`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, JSON.stringify(artifact, null, 2), "utf-8");
    logger.info("RECORDER", `Session artifact written: ${filepath}`);
    return filepath;
  }
}
