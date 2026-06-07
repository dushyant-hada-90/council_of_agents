import { EventEmitter } from "events";
import { AgentSession } from "./agentSession";
import { AudioMixer } from "./audioMixer";
import { logger } from "./logger";
import type { MaxAiTurnsBeforeHuman } from "../lib/agents/types";
import { InterruptPlaybackReport } from "./conferenceTypes";
import { agentNamesMatch, normalizeAgentNameToken } from "./nameMatching";
import { SessionRecorder } from "./sessionRecorder";
import {
  ConversationTurn,
  pickSpeakerAndRespondWithGemini,
  shouldContinueChainWithGemini,
} from "./nextSpeakerRouter";
import type { HumanTranscriptMeta } from "./humanTranscribe";
import { getEnv } from "../lib/env";

// ─── FSM State definitions ────────────────────────────────────────────────────

export type OrchestratorState =
  | "IDLE"           // No one is speaking. Waiting for human input.
  | "HUMAN_SPEAKING" // Human is actively transmitting audio.
  | "DECIDING"       // Human stopped; silence timeout pending; selecting next agent.
  | "AGENT_SPEAKING"; // An agent is generating audio and streaming it.

// ─── Events emitted to the client gateway ────────────────────────────────────

export type { InterruptPlaybackReport } from "./conferenceTypes";

type SpeechAddressee =
  | { kind: "everyone" }
  | { kind: "human" }
  | { kind: "agent"; agent: AgentRecord };

export type TranscriptAddresseeMeta = {
  kind: "everyone" | "human" | "agent";
  name?: string;
};

export type TranscriptReplyToMeta = {
  kind: "human" | "agent";
  name: string;
};

export type OrchestratorEvents = {
  /** Signal the browser to flush playout and ignore stale audio frames. */
  stopClientAudio: [epoch: number];
  /** An agent is about to speak — UI should light up their card. */
  agentSpeakingStart: [agentId: string, agentName: string];
  /** An agent finished speaking naturally. */
  agentSpeakingEnd: [agentId: string];
  /** Full or partial transcript line for the Live Transcript pane. */
  transcript: [
    agentId: string,
    agentName: string,
    text: string,
    partial?: boolean,
    addressee?: TranscriptAddresseeMeta,
    replyTo?: TranscriptReplyToMeta,
  ];
  /** A critical system event for the Event Log pane. */
  systemEvent: [message: string];
  /** Current FSM state changed — useful for the event log. */
  stateChange: [prev: OrchestratorState, next: OrchestratorState];
  /** Last speaker is asking the Human a question before the queue drains. */
  humanInvited: [agentId: string, agentName: string];
  /** Engagement question done — Human's turn to speak. */
  humanTurnReady: [];
};

// ─── Agent selection bookkeeping ─────────────────────────────────────────────

interface AgentRecord {
  id: string;
  name: string;
  session: AgentSession;
  systemPrompt: string;
  /** Higher weight = more likely to be selected. Starts at 1.0. */
  selectionWeight: number;
  /** Unix timestamp of when this agent last finished speaking. 0 = never. */
  lastSpokAt: number;
  /** How many times this agent has spoken in this session. */
  speakCount: number;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * The Finite State Machine that controls who speaks, when, and for how long.
 *
 * States:
 *   IDLE → HUMAN_SPEAKING  (human pushes PTT)
 *   HUMAN_SPEAKING → DECIDING  (human releases PTT / silence detected)
 *   DECIDING → AGENT_SPEAKING  (silence timeout elapsed, agent selected)
 *   AGENT_SPEAKING → IDLE      (agent finishes or is interrupted)
 *   AGENT_SPEAKING → HUMAN_SPEAKING  (human interrupts mid-agent-turn)
 */
export class Orchestrator extends EventEmitter {
  private state: OrchestratorState = "IDLE";
  private agents: AgentRecord[] = [];
  private mixer: AudioMixer;

  /** The agent currently speaking (or last to speak). */
  private activeAgent: AgentRecord | null = null;

  /** Timer used in the DECIDING state to wait for silence. */
  private silenceTimer: NodeJS.Timeout | null = null;

  /** Timer used to trigger a chain-reaction agent response after an agent finishes. */
  private chainTimer: NodeJS.Timeout | null = null;

  /** Silence duration before agent selection after human stops speaking (ms). */
  private readonly SILENCE_TIMEOUT_MS = 500;

  /**
   * Fallback probability when Gemini is unavailable for chain continuation decisions.
   * The FIRST reaction after a human turn is always guaranteed.
   */
  private readonly CHAIN_REACTION_PROBABILITY = 0.80;

  /**
   * Delay before a chain-reaction agent speaks (ms).
   */
  private readonly CHAIN_REACTION_DELAY_MS = 900;

  /** Hard backstop — Gemini normally decides when chains end; this prevents runaway loops. */
  private readonly CHAIN_SAFETY_MAX = 12;

  /** How many agent-to-agent turns have happened in the current chain. */
  private chainTurnCount = 0;

  /**
   * Agents that completed response.done in the current round (since human last spoke).
   * Used on interrupt to roll back unheard assistant context.
   */
  private agentsCompletedThisRound: string[] = [];

  /** Agent ids who spoke in the last N turns — blocked from random fallback entirely. */
  private recentAgentSpeakerIds: string[] = [];
  private readonly RECENT_SPEAKER_BLOCK_TURNS = 2;

  /** Waiting for human STT before picking who responds. */
  private awaitingHumanTranscript = false;

  /** Fallback if transcription is slow or never delivered. */
  private transcriptFallbackTimer: NodeJS.Timeout | null = null;
  private readonly transcriptFallbackMs = getEnv().HUMAN_STT_TIMEOUT_MS;
  private transcriptStatusProvider: (() => string) | null = null;

  /** Last human utterance from STT — used for name routing. */
  private lastHumanTranscript: string | null = null;

  /** True when the human directly named someone this turn — skip auto chain afterward. */
  private humanAddressedThisRound = false;

  /** Follow-up turn where the last speaker asks the Human an engaging question. */
  private engagementTurnActive = false;

  /** Rolling transcript for Gemini turn-taking (trimmed). */
  private conversationTurns: ConversationTurn[] = [];
  private readonly MAX_CONVERSATION_TURNS = 24;

  /** Last agent who finished a turn — router should not re-pick unless asked. */
  private lastFinishedSpeakerId: string | null = null;

  /** Gemini router for next speaker (merged pick + response). */
  private readonly routingEnabled: boolean;

  /** Structured session replay artifact collector. */
  private readonly recorder: SessionRecorder | null;

  /** Display name of the live human participant. */
  private readonly humanName: string;

  /** Max agent-only turns before inviting human participation. */
  private readonly maxAiTurnsBeforeHuman: MaxAiTurnsBeforeHuman;

  /** Agent turns since human last spoke (excluding engagement). */
  private aiTurnsSinceHuman = 0;

  /** Bumped on interrupt so stale async Gemini picks are ignored. */
  private selectionGeneration = 0;

  /** Whether the in-flight agent turn is replying to the human or continuing a chain. */
  private activeTurnContext: "human_turn" | "chain" = "chain";
  /** Agent id the active chain turn is reacting to (if chain). */
  private replyChainFromId: string | null = null;

  /** Alternate spellings Whisper may produce for agent first names. */
  private static readonly NAME_ALIASES: Record<string, string[]> = {
    sara: ["sara", "sarah", "sera", "farah", "sarahh"],
    rohan: ["rohan", "rohaan"],
    priya: ["priya", "preeya", "priyah"],
    vikram: ["vikram", "vikrum"],
    anika: ["anika", "anica", "anneka"],
  };

  /** Common Whisper mishearings of participant names in human speech. */
  private static readonly HUMAN_SPEAKER_HINTS: Record<string, string> = {
    farah: "Sara",
    sarah: "Sara",
    sera: "Sara",
  };

  /** Per-agent dissent cue — breaks the agree-and-rephrase loop. */
  private static readonly DISSENT_CUES: Record<string, string> = {
    "agent-rohan":
      "The table may be converging. You're not convinced — what's the angle they're missing? Push on one assumption.",
    "agent-vikram":
      "The group just reached consensus. As devil's advocate, poke a hole — what's the failure mode nobody said?",
    "agent-priya":
      "This is getting too practical. Bring it back to the human cost, meaning, or emotional truth underneath.",
    "agent-anika":
      "Claims are flying without evidence. Ask for proof, cite a counterexample, or name the bias in the last point.",
    "agent-sara":
      "The table may be trading dignity for efficiency. Push back — authentic connection is your stake, not neutral facilitation.",
  };

  constructor(
    mixer: AudioMixer,
    recorder?: SessionRecorder,
    options?: { humanName?: string; maxAiTurnsBeforeHuman?: MaxAiTurnsBeforeHuman }
  ) {
    super();
    this.mixer = mixer;
    this.routingEnabled = true;
    this.recorder = recorder ?? null;
    this.humanName = options?.humanName ?? "You";
    this.maxAiTurnsBeforeHuman = options?.maxAiTurnsBeforeHuman ?? 4;
    logger.info("ORCHESTRATOR", "Gemini next-speaker router enabled");
  }

  /** RoomManager supplies live STT status for timeout fallback logs. */
  public setTranscriptStatusProvider(provider: () => string): void {
    this.transcriptStatusProvider = provider;
  }

  // ─── Agent registration ─────────────────────────────────────────────────────

  public registerAgent(session: AgentSession, name: string, systemPrompt = ""): void {
    const record: AgentRecord = {
      id: session.agentId,
      name,
      session,
      systemPrompt,
      selectionWeight: 1.0,
      lastSpokAt: 0,
      speakCount: 0,
    };

    this.agents.push(record);

    // Wire response lifecycle events
    session.on("responseDone", (status: string, agentId: string) => {
      if (this.activeAgent?.id !== agentId) return;
      if (this.state !== "AGENT_SPEAKING") return;
      if (/cancel/i.test(status)) return;
      this.handleAgentDone(agentId);
    });

    session.on("audioDelta", (_delta: string, id: string) => {
      this.recorder?.recordFirstAudioDelta(id);
    });

    session.on("transcriptDone", (text: string, agentId: string) => {
      if (this.state !== "AGENT_SPEAKING" || this.activeAgent?.id !== agentId) return;
      const agent = this.findAgent(agentId);
      if (agent && text.trim()) {
        this.appendConversationTurn("agent", agentId, agent.name, text);
        const addressee = this.describeAddressee(text, agent);
        const replyTo = this.buildReplyToMeta();
        this.recorder?.recordTurn({
          speakerId: agentId,
          speaker: agent.name,
          role: "agent",
          text: text.trim(),
          addressee,
          replyTo,
        });
        this.emit("transcript", agentId, agent.name, text, false, addressee, replyTo);
      }
    });

    session.on("error", (err: Error, agentId: string) => {
      logger.error("ORCHESTRATOR", `Agent ${agentId} error: ${err.message}`);
      this.emit("systemEvent", `ERROR [${agentId}]: ${err.message}`);
      // If the active agent errored, recover to IDLE
      if (this.activeAgent?.id === agentId && this.state === "AGENT_SPEAKING") {
        this.transitionTo("IDLE", "agent error");
      }
    });

    logger.info("ORCHESTRATOR", `Registered agent: ${session.agentId} (${name})`);
  }

  // ─── Public turn control (called by the gateway) ─────────────────────────────

  /**
   * Called when the human presses Push-To-Talk.
   * Flushes client playout, cancels all in-flight generations, rolls back
   * unheard assistant context on every agent session.
   */
  public onHumanSpeechStart(playbackReport?: InterruptPlaybackReport, playoutEpoch?: number): void {
    logger.info("ORCHESTRATOR", "Human speech START detected.");
    this.clearSilenceTimer();
    this.clearChainTimer();
    this.clearTranscriptFallbackTimer();
    this.awaitingHumanTranscript = false;
    this.humanAddressedThisRound = false;
    this.engagementTurnActive = false;
    this.lastHumanTranscript = null;
    this.chainTurnCount = 0;
    this.aiTurnsSinceHuman = 0;
    this.recentAgentSpeakerIds = [];
    this.selectionGeneration++;

    this.handleInterrupt(playbackReport, playoutEpoch);
    this.transitionTo("HUMAN_SPEAKING", "human PTT");
  }

  /**
   * Core interrupt handler — separates media authority from generation authority.
   */
  private handleInterrupt(report?: InterruptPlaybackReport, playoutEpoch?: number): void {
    const interruptedAgent = this.activeAgent;

    // Drop active speaker before cancel so late response.done cannot chain another turn
    this.activeAgent = null;
    this.engagementTurnActive = false;

    // 1. Tell client to hard-flush playout queue (stale epoch frames dropped server-side too)
    this.emit("stopClientAudio", playoutEpoch ?? 0);

    // 2. Cancel any agent still generating audio
    for (const agent of this.agents) {
      agent.session.forceCancelResponse();
    }

    // 3. Wipe all uncommitted mix-minus input audio on every agent
    this.mixer.clearAllBuffers();

    // 4. Emit partial transcript for whatever the human actually heard before interrupting
    if (report?.partial) {
      const partialAgent = this.findAgent(report.partial.agentId);
      if (partialAgent) {
        const partialText = partialAgent.session.getTranscriptUpToMs(report.partial.audioEndMs);
        if (partialText) {
          this.recorder?.recordTurn({
            speakerId: report.partial.agentId,
            speaker: partialAgent.name,
            role: "agent",
            text: partialText,
            partial: true,
          });
          this.emit("transcript", report.partial.agentId, partialAgent.name, partialText, true);
        }
      }
    }

    const rollbackSummary = this.summarizeRollback(report, interruptedAgent);

    // 5. Roll back assistant conversation items the human never heard
    if (report) {
      this.rollbackUnheardContext(report, interruptedAgent);
    } else {
      // No playback report — conservative: roll back all agents from this round
      for (const agentId of this.agentsCompletedThisRound) {
        const agent = this.findAgent(agentId);
        agent?.session.rollbackAssistantAudio("delete");
      }
      if (interruptedAgent && !this.agentsCompletedThisRound.includes(interruptedAgent.id)) {
        interruptedAgent.session.rollbackAssistantAudio("delete");
      }
    }

    // 6. Clear round tracking and end any visible agent speaking state
    if (interruptedAgent) {
      this.emit("agentSpeakingEnd", interruptedAgent.id);
      this.emit("systemEvent", `INTERRUPTED: playback flushed, context rolled back`);
    }

    this.recorder?.recordInterrupt({
      playoutEpoch: playoutEpoch ?? 0,
      interruptedBy: "human",
      activeAgentId: interruptedAgent?.id ?? null,
      activeAgentName: interruptedAgent?.name ?? null,
      playbackReport: report ?? null,
      rollback: rollbackSummary,
      agentsCompletedThisRound: [...this.agentsCompletedThisRound],
    });

    this.agentsCompletedThisRound = [];
  }

  /** Compute rollback actions before they are applied — for session replay artifact. */
  private summarizeRollback(
    report?: InterruptPlaybackReport,
    activeAgent: AgentRecord | null = this.activeAgent
  ): Array<{ agentId: string; agentName: string; mode: "delete" | "truncate"; audioEndMs?: number }> {
    const actions: Array<{
      agentId: string;
      agentName: string;
      mode: "delete" | "truncate";
      audioEndMs?: number;
    }> = [];

    const push = (agentId: string, mode: "delete" | "truncate", audioEndMs?: number) => {
      const agent = this.findAgent(agentId);
      actions.push({
        agentId,
        agentName: agent?.name ?? agentId,
        mode,
        ...(audioEndMs !== undefined ? { audioEndMs } : {}),
      });
    };

    if (!report) {
      for (const agentId of this.agentsCompletedThisRound) push(agentId, "delete");
      if (activeAgent && !this.agentsCompletedThisRound.includes(activeAgent.id)) {
        push(activeAgent.id, "delete");
      }
      return actions;
    }

    const heardSet = new Set(report.fullyHeard);
    if (report.partial) heardSet.add(report.partial.agentId);
    const unheardSet = new Set(report.unheard);

    for (const agentId of this.agentsCompletedThisRound) {
      if (unheardSet.has(agentId)) {
        push(agentId, "delete");
      } else if (report.partial?.agentId === agentId) {
        push(agentId, "truncate", report.partial.audioEndMs);
      } else if (!heardSet.has(agentId)) {
        push(agentId, "delete");
      }
    }

    if (activeAgent && !this.agentsCompletedThisRound.includes(activeAgent.id)) {
      if (report.partial?.agentId === activeAgent.id) {
        push(activeAgent.id, "truncate", report.partial.audioEndMs);
      } else {
        push(activeAgent.id, "delete");
      }
    }

    return actions;
  }

  /**
   * Align each agent's conversation history with what the human actually heard.
   */
  private rollbackUnheardContext(
    report: InterruptPlaybackReport,
    activeAgent: AgentRecord | null
  ): void {
    const heardSet = new Set(report.fullyHeard);
    if (report.partial) heardSet.add(report.partial.agentId);

    const unheardSet = new Set(report.unheard);

    for (const agentId of this.agentsCompletedThisRound) {
      const agent = this.findAgent(agentId);
      if (!agent) continue;

      if (unheardSet.has(agentId)) {
        agent.session.rollbackAssistantAudio("delete");
        logger.info("ORCHESTRATOR", `Rolled back unheard response from ${agent.name}`);
      } else if (report.partial?.agentId === agentId) {
        agent.session.rollbackAssistantAudio("truncate", report.partial.audioEndMs);
        logger.info(
          "ORCHESTRATOR",
          `Truncated ${agent.name}'s response at ${report.partial.audioEndMs}ms`
        );
      } else if (!heardSet.has(agentId)) {
        // Completed on server but not in client report — treat as unheard
        agent.session.rollbackAssistantAudio("delete");
        logger.info("ORCHESTRATOR", `Rolled back unreported response from ${agent.name}`);
      }
    }

    // Agent still generating (not in completed list) — cancel already handled; delete partial item
    if (activeAgent && !this.agentsCompletedThisRound.includes(activeAgent.id)) {
      if (report.partial?.agentId === activeAgent.id) {
        activeAgent.session.rollbackAssistantAudio("truncate", report.partial.audioEndMs);
      } else {
        activeAgent.session.rollbackAssistantAudio("delete");
      }
    }
  }

  /**
   * Called when the human releases Push-To-Talk (or a silence threshold is met).
   * Begins the decision window to select the next agent.
   */
  public onHumanSpeechEnd(): void {
    if (this.state !== "HUMAN_SPEAKING") return;

    logger.info("ORCHESTRATOR", "Human speech END — awaiting transcript before selecting responder…");
    this.chainTurnCount = 0;
    this.agentsCompletedThisRound = [];
    this.awaitingHumanTranscript = true;
    this.transitionTo("DECIDING", "human released PTT");

    this.clearTranscriptFallbackTimer();
    this.transcriptFallbackTimer = setTimeout(() => {
      this.transcriptFallbackTimer = null;
      if (this.awaitingHumanTranscript && this.state === "DECIDING") {
        const status = this.transcriptStatusProvider?.() ?? "STT status unknown";
        logger.warn(
          "ORCHESTRATOR",
          `Transcript fallback after ${this.transcriptFallbackMs}ms — selecting responder without text. ${status}`
        );
        this.recorder?.markSttTimedOut();
        this.scheduleAgentSelection();
      }
    }, this.transcriptFallbackMs);
  }

  /**
   * Called when Google STT returns the human's utterance (or a failure/empty result).
   * Appends the utterance to conversation history; Gemini routes the next speaker.
   */
  public onHumanTranscript(text: string | null, meta?: HumanTranscriptMeta): void {
    if (!this.awaitingHumanTranscript || this.state !== "DECIDING") return;

    this.awaitingHumanTranscript = false;
    this.clearTranscriptFallbackTimer();

    this.lastHumanTranscript = text;
    if (!text?.trim() && meta) {
      logger.warn("ORCHESTRATOR", `Human transcript empty (${meta.source}): ${meta.detail}`);
    }
    if (text?.trim()) {
      this.appendConversationTurn("human", "human", this.humanName, text);
      this.recorder?.recordTurn({
        speakerId: "human",
        speaker: this.humanName,
        role: "human",
        text: text.trim(),
      });
    }
    this.humanAddressedThisRound = false;
    this.scheduleAgentSelection();
  }

  private scheduleAgentSelection(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      void this.selectAndTriggerAgent("human_turn");
    }, this.SILENCE_TIMEOUT_MS);
  }

  private appendConversationTurn(
    role: "human" | "agent",
    speakerId: string,
    speaker: string,
    text: string
  ): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.conversationTurns.push({ role, speakerId, speaker, text: trimmed });
    if (this.conversationTurns.length > this.MAX_CONVERSATION_TURNS) {
      this.conversationTurns.splice(
        0,
        this.conversationTurns.length - this.MAX_CONVERSATION_TURNS
      );
    }
    this.syncTurnToPeerSessions(role, speakerId, speaker, trimmed);
  }

  /**
   * Mirror each spoken turn into every agent's session history via
   * conversation.item.create. Mix-minus audio is live acoustics; this is durable memory.
   */
  private syncTurnToPeerSessions(
    role: "human" | "agent",
    speakerId: string,
    speaker: string,
    text: string
  ): void {
    const label = role === "human" ? this.humanName : speaker;

    for (const agent of this.agents) {
      if (agent.session.state === "CLOSED") continue;
      // Speaker already has their own assistant item from response.create.
      if (role === "agent" && agent.id === speakerId) continue;
      agent.session.injectTableSpeech(label, text);
    }
  }

  private humanNamePattern(): string {
    return `human|${this.humanName.toLowerCase()}`;
  }

  /**
   * True only when the speaker is inviting the live human to respond — not when
   * "human" appears in general speech ("human nature", "Human, the theorem…").
   */
  private isDirectQuestionToHuman(lower: string): boolean {
    const name = this.humanNamePattern();
    const addressesHuman =
      new RegExp(`^\\s*(?:${name})\\s*[,?!:]`, "i").test(lower) ||
      new RegExp(`\\b(hey|hi|hello|okay|ok)\\s+(?:${name})\\s*[,?!]`, "i").test(lower) ||
      new RegExp(
        `\\b(?:${name})\\s*,\\s*(what|how|where|when|why|do you|would you|can you|are you|did you)\\b`,
        "i"
      ).test(lower);

    if (!addressesHuman) {
      if (new RegExp(`^\\s*(?:${name})\\b`, "i").test(lower) && /\?/.test(lower)) return true;
      return false;
    }

    return (
      /\?/.test(lower) ||
      new RegExp(`\\b(what|how|where|when|why)\\b[^.?!]{0,50}\\b(you|human|${this.humanName})\\b`, "i").test(
        lower
      ) ||
      /\b(your turn|hear from you|like to hear from you|want your take)\b/i.test(lower) ||
      /\bwhat do you think\b/i.test(lower) ||
      new RegExp(`\\b(tell me|ask)\\b[^.?!]{0,40}\\b(you|human|${this.humanName})\\b`, "i").test(lower)
    );
  }

  private scoreHumanAsAddressee(lower: string): number {
    if (!this.isDirectQuestionToHuman(lower)) return 0;
    let score = 20;
    if (new RegExp(`^\\s*(?:${this.humanNamePattern()})\\s*[,?!:]`, "i").test(lower)) score += 8;
    if (/\?/.test(lower)) score += 6;
    return score;
  }

  /** Open group broadcast — no single directed recipient. */
  private isBroadcastToEveryone(lower: string): boolean {
    return (
      /\beveryone\b/i.test(lower) ||
      /\beverybody\b/i.test(lower) ||
      /\ball of you\b/i.test(lower) ||
      /\byou all\b/i.test(lower) ||
      /\bthe (whole )?room\b/i.test(lower) ||
      /\bthe table\b/i.test(lower) ||
      /\banyone\b/i.test(lower) ||
      /\banybody\b/i.test(lower) ||
      /\bwhat do you (guys |all )?think\b/i.test(lower)
    );
  }

  /**
   * Who is this utterance directed at? Used for agent→agent / agent→human routing.
   * Excludes the speaker from agent matches.
   */
  private resolveSpeechAddressee(text: string, speaker?: AgentRecord): SpeechAddressee {
    const lower = text.toLowerCase();
    const humanScore = this.scoreHumanAsAddressee(lower);
    const mentioned = this.getMentionedAgents(text).filter((a) => a.id !== speaker?.id);

    if (mentioned.length === 1 && humanScore < 12) {
      const score = this.scoreAgentAsAddressee(lower, mentioned[0]!);
      if (score >= 8) return { kind: "agent", agent: mentioned[0]! };
    }

    if (mentioned.length > 1) {
      const scored = mentioned
        .map((agent) => ({ agent, score: this.scoreAgentAsAddressee(lower, agent) }))
        .sort((a, b) => b.score - a.score);
      const best = scored[0]!;
      if (scored.length >= 2 && best.score >= scored[1]!.score + 3) {
        return { kind: "agent", agent: best.agent };
      }
      if (best.score >= 8) return { kind: "agent", agent: best.agent };
    }

    if (humanScore > 0 && mentioned.length === 0) return { kind: "human" };

    if (humanScore > 0 && mentioned.length > 0) {
      const bestAgent = mentioned
        .map((agent) => ({ agent, score: this.scoreAgentAsAddressee(lower, agent) }))
        .sort((a, b) => b.score - a.score)[0]!;
      if (humanScore >= bestAgent.score + 4) return { kind: "human" };
      if (bestAgent.score >= 8) return { kind: "agent", agent: bestAgent.agent };
    }

    if (this.isBroadcastToEveryone(lower)) return { kind: "everyone" };

    return { kind: "everyone" };
  }

  private describeAddressee(text: string, speaker: AgentRecord): TranscriptAddresseeMeta {
    const target = this.resolveSpeechAddressee(text, speaker);
    if (target.kind === "human") return { kind: "human" };
    if (target.kind === "agent") return { kind: "agent", name: target.agent.name };
    return { kind: "everyone" };
  }

  private nameAppearsInText(lower: string, agentName: string): boolean {
    const canonical = agentName.toLowerCase();
    const aliases = Orchestrator.NAME_ALIASES[canonical] ?? [canonical];
    const forms = new Set<string>([canonical, ...aliases.map((a) => a.toLowerCase())]);
    for (const alias of aliases) {
      forms.add(normalizeAgentNameToken(alias));
    }
    forms.add(normalizeAgentNameToken(canonical));

    if ([...forms].some((form) => new RegExp(`\\b${this.escapeRegex(form)}\\b`, "i").test(lower))) {
      return true;
    }

    // Token-level match for compact spellings Whisper may produce
    const tokens = lower.match(/\b[a-z']+\b/g) ?? [];
    return tokens.some((tok) => {
      const norm = normalizeAgentNameToken(tok);
      return norm === normalizeAgentNameToken(canonical);
    });
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** All agents whose name appears anywhere in the human transcript. */
  private getMentionedAgents(text: string): AgentRecord[] {
    const lower = text.toLowerCase();
    return this.agents.filter((a) => this.nameAppearsInText(lower, a.name));
  }

  /** Name appears as topic / negated identity, not as someone being spoken to. */
  private isNameReferencedNotAddressed(lower: string, alias: string): boolean {
    const a = this.escapeRegex(alias);
    const negated = [
      new RegExp(`\\b(won'?t|will not|not|never|don'?t)\\b[^.?!]{0,40}\\b(speak|talk|respond)\\s+(as|for|like)\\s+${a}\\b`, "i"),
      new RegExp(`\\b(speak|talk)\\s+(as|for|like)\\s+${a}\\b[^.?!]{0,24}\\b(but|instead|however)\\b`, "i"),
      new RegExp(`\\b(instead of|rather than|unlike)\\s+${a}\\b`, "i"),
      new RegExp(`\\b${a}'s\\s+(take|view|perspective|angle|role|position|lens)\\b`, "i"),
      new RegExp(`\\bfrom\\s+${a}'s\\s+(perspective|view|angle)\\b`, "i"),
    ];
    return negated.some((p) => p.test(lower));
  }

  private scoreAgentAsAddressee(lower: string, agent: AgentRecord): number {
    const name = agent.name.toLowerCase();
    const aliases = Orchestrator.NAME_ALIASES[name] ?? [name];
    let score = 0;

    for (const alias of aliases) {
      if (!new RegExp(`\\b${alias}\\b`, "i").test(lower)) continue;
      if (this.isNameReferencedNotAddressed(lower, alias)) continue;
      score += 5;

      if (new RegExp(`^\\s*(hey|hi|hello|yo|okay|ok)\\s+${alias}\\b`, "i").test(lower)) score += 15;
      if (new RegExp(`\\b(hey|hi|hello|yo)\\s+${alias}\\b`, "i").test(lower)) score += 12;
      if (new RegExp(`\\b${alias}\\s*[,?!:]`, "i").test(lower)) score += 10;
      if (new RegExp(`\\b${alias}'s\\b`, "i").test(lower)) score += 14;
      if (new RegExp(`\\babout\\s+${alias}\\b`, "i").test(lower)) score += 14;
      if (new RegExp(`\\bfor\\s+${alias}\\b`, "i").test(lower)) score += 10;
      if (new RegExp(`\\bto\\s+${alias}\\b`, "i").test(lower)) score += 10;
      if (new RegExp(`\\b(ask|tell)\\s+${alias}\\b`, "i").test(lower)) score += 14;
      if (new RegExp(`\\b(ask|tell|hear from|talk to)\\b[^.?!]{0,40}\\b${alias}\\b`, "i").test(lower)) score += 12;
      if (new RegExp(`\\b(what|how)\\b[^.?!]{0,30}\\b${alias}\\b`, "i").test(lower)) score += 10;
      if (new RegExp(`\\b${alias}\\b[^.?!]{0,50}\\?`, "i").test(lower)) score += 8;
      if (lower.trimStart().startsWith(alias)) score += 8;
    }

    return score;
  }

  /**
   * Score how strongly the human invited this agent to speak (not merely mentioned them).
   */
  private scoreInvitedToSpeak(lower: string, agent: AgentRecord): number {
    const name = agent.name.toLowerCase();
    const aliases = Orchestrator.NAME_ALIASES[name] ?? [name];
    let score = 0;

    for (const alias of aliases) {
      if (!new RegExp(`\\b${alias}\\b`, "i").test(lower)) continue;

      if (
        new RegExp(
          `\\b(hear from|like to hear from|want to hear from|turn to|go to|let's hear from|i would like to hear from|i'd like to hear from)\\b[^.?!]{0,80}\\b${alias}\\b`,
          "i"
        ).test(lower)
      ) {
        score += 30;
      }
      if (new RegExp(`\\b(ask|tell)\\s+${alias}\\b`, "i").test(lower)) score += 22;
      if (new RegExp(`^\\s*(hey|hi|hello|okay|ok)\\s+${alias}\\b`, "i").test(lower)) score += 18;
      if (new RegExp(`\\b${alias}\\s*[,?!:]`, "i").test(lower)) score += 14;
      if (new RegExp(`\\b(what do you think|your take|your view)\\b[^.?!]{0,40}\\b${alias}\\b`, "i").test(lower)) {
        score += 10;
      }
    }

    return score;
  }

  /** True when the human clearly invited this agent to take the floor. */
  private isInvitedToSpeak(text: string, agent: AgentRecord): boolean {
    return this.scoreInvitedToSpeak(text.toLowerCase(), agent) >= 12;
  }

  /**
   * Fallback when Gemini is unavailable: pick who the human invited to speak.
   * Distinguishes "hear from Vikram about Priya" (Vikram) from "about Priya" alone.
   */
  private resolveHumanAddressee(text: string): AgentRecord | null {
    const mentioned = [...this.getMentionedAgents(text)];
    const tokens = text.match(/\b[A-Za-z']+\b/g) ?? [];
    for (const tok of tokens) {
      for (const agent of this.agents) {
        if (
          agentNamesMatch(tok, agent.name) &&
          !mentioned.some((m) => m.id === agent.id)
        ) {
          mentioned.push(agent);
        }
      }
    }
    if (mentioned.length === 0) return null;

    const lower = text.toLowerCase();
    const scored = mentioned
      .map((agent) => ({
        agent,
        score:
          this.scoreInvitedToSpeak(lower, agent) * 2 +
          this.scoreAgentAsAddressee(lower, agent),
      }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0]!;
    if (best.score < 12) return null;
    if (scored.length >= 2 && best.score < scored[1]!.score + 4) return null;
    return best.agent;
  }

  /** Clear uncommitted human audio on every agent except the one about to speak. */
  private isolateAgentInput(selected: AgentRecord): void {
    for (const agent of this.agents) {
      if (agent.id !== selected.id) {
        agent.session.clearAudioBuffer();
      }
    }
  }

  // ─── Selection engine ────────────────────────────────────────────────────────

  private trackAgentSpeaker(agentId: string): void {
    this.recentAgentSpeakerIds.push(agentId);
    while (this.recentAgentSpeakerIds.length > this.RECENT_SPEAKER_BLOCK_TURNS) {
      this.recentAgentSpeakerIds.shift();
    }
  }

  private isOnSpeakerCooldown(agentId: string): boolean {
    return this.recentAgentSpeakerIds.includes(agentId);
  }

  /** Weighted-random fallback when Gemini is unavailable or returns "random". */
  private pickWeightedRandom(pool: AgentRecord[]): AgentRecord {
    const weights = pool.map((agent) => {
      if (this.isOnSpeakerCooldown(agent.id)) return 0;
      let w = agent.selectionWeight;
      if (agent.id === this.lastFinishedSpeakerId) w *= 0.05;
      return w;
    });

    let eligible = pool.filter((_, i) => weights[i]! > 0);
    if (eligible.length === 0) {
      eligible = pool.filter((a) => a.id !== this.lastFinishedSpeakerId);
    }
    if (eligible.length === 0) eligible = pool;

    const eligibleWeights = eligible.map((agent) => {
      const idx = pool.indexOf(agent);
      const w = weights[idx]!;
      return w > 0 ? w : 0.01;
    });

    const totalWeight = eligibleWeights.reduce((sum, w) => sum + w, 0);
    let rand = Math.random() * totalWeight;
    for (let i = 0; i < eligible.length; i++) {
      rand -= eligibleWeights[i]!;
      if (rand <= 0) return eligible[i]!;
    }
    return eligible[0]!;
  }

  /**
   * Pick the next speaker: Gemini merged turn → name-match fallback → weighted random.
   */
  private async selectAndTriggerAgent(
    selectionContext: "human_turn" | "chain" = "human_turn"
  ): Promise<void> {
    const generation = this.selectionGeneration;

    if (this.agents.length === 0) {
      logger.warn("ORCHESTRATOR", "No agents registered — returning to IDLE.");
      this.transitionTo("IDLE", "no agents");
      return;
    }

    const readyAgents = this.agents.filter((a) => a.session.state !== "CLOSED");

    if (readyAgents.length === 0) {
      logger.warn("ORCHESTRATOR", "All agents closed — returning to IDLE.");
      this.transitionTo("IDLE", "all agents closed");
      return;
    }

    let selectedAgent: AgentRecord | null = null;
    let selectionLabel = "";
    let usedNamedFallback = false;
    let geminiPickReason: string | undefined;
    let preGeneratedText: string | undefined;

    // Human named someone — skip merged routing; use a single response-only call.
    if (selectionContext === "human_turn" && this.lastHumanTranscript) {
      const named = this.resolveHumanAddressee(this.lastHumanTranscript);
      if (named && readyAgents.some((a) => a.id === named.id)) {
        selectedAgent = named;
        selectionLabel = `NAMED: ${named.name} (human addressed)`;
        usedNamedFallback = true;
      }
    }

    if (!selectedAgent && this.routingEnabled) {
      this.emit("systemEvent", `GEMINI: routing + generating response…`);
      this.recorder?.markRoutingStart(selectionContext);
      const pick = await pickSpeakerAndRespondWithGemini({
        humanName: this.humanName,
        turns: this.conversationTurns,
        candidates: readyAgents.map((a) => ({
          id: a.id,
          name: a.name,
          systemPrompt: a.systemPrompt,
        })),
        lastSpeakerId: this.lastFinishedSpeakerId ?? undefined,
        recentSpeakerIds: this.recentAgentSpeakerIds,
        context: selectionContext,
        scenarioHint: this.buildMergedTurnGuidance(selectionContext),
      });

      if (generation !== this.selectionGeneration) return;

      if (pick.source === "gemini" && pick.kind === "human") {
        if (selectionContext === "chain") {
          logger.info("ORCHESTRATOR", "Gemini routed to Human — inviting human to speak.");
          this.recorder?.recordRouting({
            context: "chain",
            selectedSpeakerId: "human",
            selectedSpeaker: this.humanName,
            source: "human_handoff",
            reason: pick.reason,
            label: `GEMINI: ${this.humanName}'s turn${pick.reason ? ` — ${pick.reason}` : ""}`,
          });
          this.emit("systemEvent", `GEMINI: ${this.humanName}'s turn (${pick.reason ?? "natural pause"})`);
          this.chainTurnCount = 0;
          this.activeAgent = null;
          this.transitionTo("IDLE", "gemini human turn");
          this.emit("humanTurnReady");
          this.lastHumanTranscript = null;
          return;
        }
        logger.warn(
          "ORCHESTRATOR",
          `Gemini routed to ${this.humanName} after ${this.humanName} spoke (invalid on human_turn)${pick.reason ? ` — ${pick.reason}` : ""} — using random agent.`
        );
      }

      if (pick.source === "gemini" && pick.kind === "agent") {
        const agent = this.findAgent(pick.agentId);
        if (agent && readyAgents.some((a) => a.id === agent.id)) {
          selectedAgent = agent;
          geminiPickReason = pick.reason;
          preGeneratedText = pick.response;
          selectionLabel = `GEMINI: ${agent.name}${pick.reason ? ` — ${pick.reason}` : ""}`;
        }
      }
    }

    if (!selectedAgent) {
      selectedAgent = this.pickWeightedRandom(readyAgents);
      selectionLabel = `RANDOM: ${selectedAgent.name}`;
    }

    if (generation !== this.selectionGeneration) return;

    logger.info("ORCHESTRATOR", `Selected agent: ${selectedAgent.name}`);
    this.emit("systemEvent", `SELECTED: ${selectionLabel}`);

    const routingSource = selectionLabel.startsWith("GEMINI:")
      ? "gemini"
      : selectionLabel.startsWith("NAMED:")
        ? "named_fallback"
        : "random";
    this.recorder?.recordRouting({
      context: selectionContext,
      selectedSpeakerId: selectedAgent.id,
      selectedSpeaker: selectedAgent.name,
      source: routingSource,
      reason: geminiPickReason,
      label: selectionLabel,
    });

    const routingMethod: "merged_gemini" | "named_direct" | "random" =
      routingSource === "gemini" ? "merged_gemini"
      : routingSource === "named_fallback" ? "named_direct"
      : "random";
    this.recorder?.markRoutingResult(
      selectedAgent.id,
      selectedAgent.name,
      routingMethod,
      geminiPickReason,
      !!preGeneratedText
    );

    this.isolateAgentInput(selectedAgent);
    const humanLine =
      selectionContext === "human_turn" ? this.lastHumanTranscript : null;
    this.lastHumanTranscript = null;

    if (humanLine && selectionContext === "human_turn") {
      this.humanAddressedThisRound =
        usedNamedFallback || this.isDirectlyAddressed(humanLine, selectedAgent);
    }

    let turnInstructions: string | undefined;
    if (humanLine && selectionContext === "human_turn") {
      turnInstructions = this.buildHumanTurnInstructions(
        selectedAgent,
        humanLine,
        this.isDirectlyAddressed(humanLine, selectedAgent),
        geminiPickReason
      );
    } else if (selectionContext === "chain") {
      const fromSpeaker = this.lastFinishedSpeakerId
        ? this.findAgent(this.lastFinishedSpeakerId)
        : undefined;
      const fromText = fromSpeaker?.session.getLastTranscript() ?? "";
      if (fromSpeaker && fromText) {
        const addressee = this.resolveSpeechAddressee(fromText, fromSpeaker);
        const directlyAddressed =
          addressee.kind === "agent" && addressee.agent.id === selectedAgent.id;
        turnInstructions = this.buildChainTurnInstructions(
          selectedAgent,
          fromSpeaker,
          fromText,
          directlyAddressed
        );
      }
    }

    const skipDissent =
      !!humanLine &&
      selectionContext === "human_turn" &&
      this.isDirectlyAddressed(humanLine, selectedAgent);

    this.triggerAgentSpeech(
      selectedAgent,
      preGeneratedText
        ? undefined
        : turnInstructions
          ? this.composeTurnInstructions(selectedAgent, turnInstructions, { skipDissent })
          : this.composeTurnInstructions(selectedAgent, undefined, { skipDissent }),
      selectionContext,
      preGeneratedText
    );
  }

  private buildMergedTurnGuidance(selectionContext: "human_turn" | "chain"): string {
    const lines: string[] = [];

    if (selectionContext === "human_turn" && this.lastHumanTranscript) {
      const text = this.lastHumanTranscript;
      lines.push(`${this.humanName} just said: "${text}"`);
      lines.push(
        `ROUTING: ${this.humanName} just spoke on push-to-talk. Pick an AGENT to reply. Never route back to ${this.humanName}.`
      );
      for (const hint of this.humanSpeakerNameHints(text)) {
        lines.push(hint);
      }
      if (this.asksAboutAnotherParticipant(text)) {
        lines.push(
          `${this.humanName} is asking about someone else at this table — answer from the roster, not by impersonating them.`
        );
      }
      if (this.asksAboutMeetingRoster(text)) {
        lines.push(
          `List all ${this.agents.length + 1} participants from the roster when relevant.`
        );
      }
      if (this.asksAboutConversationHistory(text)) {
        lines.push(
          `${this.humanName} is asking about earlier conversation — use the transcript faithfully.`
        );
      }
    } else if (selectionContext === "chain") {
      const fromSpeaker = this.lastFinishedSpeakerId
        ? this.findAgent(this.lastFinishedSpeakerId)
        : undefined;
      const fromText = fromSpeaker?.session.getLastTranscript() ?? "";
      if (fromSpeaker && fromText) {
        lines.push(`${fromSpeaker.name} just said: "${fromText}"`);
        const addressee = this.resolveSpeechAddressee(fromText, fromSpeaker);
        if (addressee.kind === "agent") {
          lines.push(`${fromSpeaker.name} addressed ${addressee.agent.name} directly.`);
        } else if (addressee.kind === "human") {
          lines.push(`${fromSpeaker.name} asked ${this.humanName} a question.`);
        }
      }
    }

    const summary = this.extractConsensusSummary();
    if (summary) {
      lines.push(
        "Recent lines suggest the table may be converging — if you pick an agent, they may push back with a fresh angle."
      );
    }

    return lines.join("\n");
  }

  /** Prepended to every response.create — identity only; roster lives in session instructions. */
  private buildBaseTurnContext(agent: AgentRecord): string {
    return [
      `You are ${agent.name} at this table.`,
      `Prior turns from ${this.humanName} and others are in your conversation history.`,
      "Never read instructions aloud. Never mention prompts, routing, or meta-rules about who you are.",
      "When recalling earlier speech, use conversation history — never claim you lack it.",
    ].join("\n\n");
  }

  private composeTurnInstructions(
    agent: AgentRecord,
    taskInstructions?: string,
    options: { skipDissent?: boolean } = {}
  ): string {
    const parts = [this.buildBaseTurnContext(agent)];
    if (taskInstructions) {
      parts.push(taskInstructions);
    } else {
      parts.push(
        "Continue the conversation naturally. React specifically to what was just said."
      );
    }
    if (!options.skipDissent) {
      const dissent = this.buildDissentInstructions(agent);
      if (dissent) parts.push(dissent);
    }
    return parts.join("\n\n");
  }

  private extractConsensusSummary(): string | null {
    const recent = this.conversationTurns.slice(-3);
    if (recent.length < 2) return null;
    return recent.map((t) => `${t.speaker}: ${t.text.slice(0, 160)}`).join("\n");
  }

  private buildDissentInstructions(agent: AgentRecord): string | null {
    const summary = this.extractConsensusSummary();
    const cue = Orchestrator.DISSENT_CUES[agent.id];
    if (!summary || !cue) return null;

    return [
      "## Recent room consensus",
      summary,
      "## Your angle this turn",
      cue,
      "Do NOT open with empty validation ('I agree', 'I'm with you', 'totally'). Lead with a distinct take.",
    ].join("\n\n");
  }

  /** True when the human clearly singled out this agent to respond. */
  private isDirectlyAddressed(text: string, agent: AgentRecord): boolean {
    return (
      this.isInvitedToSpeak(text, agent) ||
      this.scoreAgentAsAddressee(text.toLowerCase(), agent) >= 10
    );
  }

  private extractTopicFocus(text: string): string | null {
    const patterns = [
      /\babout\s+(.+?)(?:\?|$)/i,
      /\bon\s+(.+?)(?:\?|$)/i,
      /\bregarding\s+(.+?)(?:\?|$)/i,
      /\bwhat do you think (?:of|about)\s+(.+?)(?:\?|$)/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        const topic = match[1].trim().replace(/[?.!,]+$/, "");
        if (topic.length >= 3 && topic.length <= 120) return topic;
      }
    }
    return null;
  }

  private buildHumanTurnInstructions(
    agent: AgentRecord,
    text: string,
    namedDirectly: boolean,
    routingReason?: string
  ): string {
    const topic = this.extractTopicFocus(text);
    const lines = [
      `## This turn`,
      `CONTEXT: ${this.humanName} just said: "${text}"`,
      `Give ${agent.name}'s reply in first person — your own view, not anyone else's voice.`,
    ];

    if (namedDirectly) {
      lines.push(
        `${this.humanName} called on you by name. Acknowledge that briefly, then answer their question.`,
        topic
          ? `Stay on ${topic} — that is what they asked about.`
          : `Answer what they actually asked — no generic tangent.`,
      );
      if (routingReason) {
        lines.push(`(Internal note: ${routingReason})`);
      }
    } else {
      lines.push(
        `Respond to ${this.humanName}'s point directly.`,
      );
    }

    if (this.asksAboutAnotherParticipant(text)) {
      lines.push(
        `${this.humanName} is asking about someone else at this table. Describe them from the roster — as a co-participant you know, not by impersonating them.`,
        `Do NOT say you lack information about table-mates or need ${this.humanName} to introduce them.`
      );
    }

    if (this.asksAboutMeetingRoster(text)) {
      lines.push(
        `List all ${this.agents.length + 1} participants from the roster above (5 agents + ${this.humanName}). Briefly describe anyone ${this.humanName} asks about.`
      );
    }

    if (this.asksAboutConversationHistory(text)) {
      lines.push(
        `${this.humanName} is asking about earlier conversation. Answer from your conversation history.`,
        `Find the relevant turn(s), then quote or summarize them faithfully. Do NOT ask ${this.humanName} to repeat what is already in your history.`,
      );
      if (/\bfirst question\b/i.test(text)) {
        lines.push(
          `Locate ${this.humanName}'s earliest line in the transcript — that is the first question. Include who answered and what they said next.`
        );
      }
      if (/\b(repeat|what did .+ say|just (now )?said)\b/i.test(text)) {
        lines.push(
          "Repeat or paraphrase the requested speaker's most recent relevant line from the transcript."
        );
      }
    }

    for (const hint of this.humanSpeakerNameHints(text)) {
      lines.push(hint);
    }

    return lines.join("\n");
  }

  private buildChainTurnInstructions(
    agent: AgentRecord,
    fromSpeaker: AgentRecord,
    fromText: string,
    directlyAddressed: boolean
  ): string {
    const topic = this.extractTopicFocus(fromText);
    const lines = [
      `## This turn`,
      `CONTEXT: ${fromSpeaker.name} just said: "${fromText}"`,
      `Give ${agent.name}'s reply in first person — react with your own view.`,
    ];

    if (directlyAddressed) {
      lines.push(
        `${fromSpeaker.name} called on you by name. Acknowledge their point, then give your take.`,
        topic ? `Stay on ${topic}.` : `React to what they asked you specifically.`,
      );
    } else {
      lines.push(
        "Continue the conversation naturally. React specifically to what was just said.",
        "If you disagree or have a strong reaction, say so directly."
      );
    }

    return lines.join("\n");
  }

  private humanSpeakerNameHints(text: string): string[] {
    const hints: string[] = [];
    const lower = text.toLowerCase();
    for (const [heard, actual] of Object.entries(Orchestrator.HUMAN_SPEAKER_HINTS)) {
      if (new RegExp(`\\b${heard}\\b`, "i").test(lower)) {
        hints.push(
          `Name hint: when ${this.humanName} said "${heard}", they mean **${actual}** (conference participant) — check that speaker's lines in the transcript.`
        );
      }
    }
    return hints;
  }

  private asksAboutConversationHistory(text: string): boolean {
    const lower = text.toLowerCase();
    return (
      /\b(first question|what did (i|he|she|they|we) (say|ask|answer|reply)|repeat what|what was said|what .+ said|earlier|just (now )?said|his (reply|answer)|her (reply|answer)|answer to me|you said|who asked)\b/i.test(
        lower
      ) || /\b(can you repeat|remind me|tell me again)\b/i.test(lower)
    );
  }

  private asksAboutAnotherParticipant(text: string): boolean {
    const lower = text.toLowerCase();
    const self = lower;
    const others = this.agents.filter((a) => this.nameAppearsInText(self, a.name));
    if (others.length === 0) return false;
    return (
      /\b(strength|weakness|useful|good at|bad at|what does|who is|know|describe|tell me about)\b/i.test(
        lower
      ) || /\b(do for a living|job|work as)\b/i.test(lower)
    );
  }

  private asksAboutMeetingRoster(text: string): boolean {
    const lower = text.toLowerCase();
    return (
      /\b(how many|participant|people|who is (here|present|in)|name all|list all|in the meeting|at the table)\b/i.test(
        lower
      ) || /\b(describe (any|one|them)|who are you)\b/i.test(lower)
    );
  }

  private buildReplyToMeta(): TranscriptReplyToMeta | undefined {
    if (this.activeTurnContext === "human_turn") {
      return { kind: "human", name: this.humanName };
    }
    if (this.replyChainFromId) {
      const prev = this.findAgent(this.replyChainFromId);
      if (prev) return { kind: "agent", name: prev.name };
    }
    return undefined;
  }

  private triggerAgentSpeech(
    agent: AgentRecord,
    extraInstructions?: string,
    turnContext: "human_turn" | "chain" = "chain",
    preGeneratedText?: string
  ): void {
    this.activeTurnContext = turnContext;
    this.replyChainFromId = turnContext === "chain" ? this.lastFinishedSpeakerId : null;
    this.activeAgent = agent;
    this.transitionTo("AGENT_SPEAKING", `selected ${agent.name}`);

    agent.speakCount++;
    agent.lastSpokAt = Date.now();
    this.trackAgentSpeaker(agent.id);

    if (turnContext === "human_turn") {
      this.recorder?.setLatencyWinner(agent.id, agent.name);
    }

    this.emit("agentSpeakingStart", agent.id, agent.name);
    this.emit("systemEvent", `SPEAKING: ${agent.name}`);

    logger.startTimer(`turn_latency_${agent.id}_${agent.speakCount}`);
    const hooks = this.recorder?.beginAgentTurn(agent.id, agent.name, turnContext, !!preGeneratedText);
    agent.session.triggerResponse(
      preGeneratedText ? undefined : (extraInstructions ?? this.composeTurnInstructions(agent)),
      { preGeneratedText, hooks }
    );
  }

  private handleAgentDone(agentId: string): void {
    const speaker = this.findAgent(agentId);
    logger.logLatency("ORCHESTRATOR", `turn_latency_${agentId}_${this.activeAgent?.speakCount ?? 0}`);

    // Engagement follow-up finished — queue will drain, Human's turn.
    if (this.engagementTurnActive) {
      this.engagementTurnActive = false;
      logger.info("ORCHESTRATOR", `${speaker?.name ?? agentId} finished engagement question.`);
      this.emit("agentSpeakingEnd", agentId);
      this.emit("systemEvent", `ENGAGE: ${speaker?.name ?? agentId} invited human`);
      this.activeAgent = null;
      this.transitionTo("IDLE", "human turn");
      this.emit("humanTurnReady");
      return;
    }

    logger.info("ORCHESTRATOR", `Agent ${agentId} finished speaking naturally.`);
    this.lastFinishedSpeakerId = agentId;
    this.agentsCompletedThisRound.push(agentId);
    this.emit("agentSpeakingEnd", agentId);
    this.emit("systemEvent", `DONE: ${speaker?.name ?? agentId} finished`);
    this.aiTurnsSinceHuman++;

    // Human named someone — they answer, then invite Human back (no chain).
    if (this.humanAddressedThisRound) {
      this.humanAddressedThisRound = false;
      this.chainTurnCount = 0;
      this.beginEngagementQuestion(speaker);
      return;
    }

    const transcript = speaker?.session.getLastTranscript() ?? "";
    const addressee = transcript ? this.resolveSpeechAddressee(transcript, speaker) : { kind: "everyone" as const };

    if (addressee.kind === "human") {
      logger.info("ORCHESTRATOR", `${speaker?.name ?? agentId} addressed ${this.humanName} — handoff after playout.`);
      this.emit("systemEvent", `ADDRESSED: ${this.humanName} (${speaker?.name ?? agentId} asked them)`);
      this.chainTurnCount = 0;
      this.activeAgent = null;
      this.transitionTo("IDLE", "agent asked human");
      this.emit("humanTurnReady");
      return;
    }

    // Chain reaction: agent-to-agent / open group after directed or broadcast turns.
    void this.evaluateChainContinuation(speaker, agentId, transcript, addressee);
  }

  private async evaluateChainContinuation(
    speaker: AgentRecord | undefined,
    agentId: string,
    transcript: string,
    addressee: SpeechAddressee
  ): Promise<void> {
    const generation = this.selectionGeneration;

    const addresseeKind =
      addressee.kind === "human"
        ? "human"
        : addressee.kind === "agent"
          ? "agent"
          : "everyone";
    const addresseeName = addressee.kind === "agent" ? addressee.agent.name : undefined;

    if (this.aiTurnsSinceHuman >= this.maxAiTurnsBeforeHuman) {
      logger.info(
        "ORCHESTRATOR",
        `AI turn threshold (${this.maxAiTurnsBeforeHuman}) reached — inviting human.`
      );
      this.emit("systemEvent", `THRESHOLD: ${this.maxAiTurnsBeforeHuman} AI turns — inviting human`);
      this.recorder?.recordChain({
        afterSpeakerId: agentId,
        afterSpeaker: speaker?.name ?? agentId,
        afterTranscript: transcript,
        chainTurnCount: this.chainTurnCount,
        addresseeKind,
        addresseeName,
        decision: "pause",
        source: "fallback",
        reason: `max AI turns (${this.maxAiTurnsBeforeHuman}) before human`,
      });
      this.chainTurnCount = 0;
      this.beginEngagementQuestion(speaker);
      return;
    }

    if (this.chainTurnCount >= this.CHAIN_SAFETY_MAX) {
      logger.info("ORCHESTRATOR", `Chain safety cap (${this.CHAIN_SAFETY_MAX}) reached.`);
      this.emit("systemEvent", `CHAIN: safety cap reached`);
      this.recorder?.recordChain({
        afterSpeakerId: agentId,
        afterSpeaker: speaker?.name ?? agentId,
        afterTranscript: transcript,
        chainTurnCount: this.chainTurnCount,
        addresseeKind,
        addresseeName,
        decision: "pause",
        source: "safety_cap",
        reason: `safety cap (${this.CHAIN_SAFETY_MAX})`,
      });
      this.chainTurnCount = 0;
      this.beginEngagementQuestion(speaker);
      return;
    }

    const isFirstReaction = this.chainTurnCount === 0;
    let shouldChain = isFirstReaction;
    let chainSource: "gemini" | "fallback" | "first_guaranteed" = "first_guaranteed";
    let chainReason: string | undefined = isFirstReaction
      ? "first reaction after human turn (guaranteed)"
      : undefined;

    if (!isFirstReaction) {
      if (this.routingEnabled) {
        const decision = await shouldContinueChainWithGemini({
          humanName: this.humanName,
          turns: this.conversationTurns,
          chainTurnCount: this.chainTurnCount,
          lastSpeakerName: speaker?.name ?? agentId,
          lastTranscript: transcript,
          addresseeKind,
          addresseeName,
        });

        if (generation !== this.selectionGeneration) return;

        shouldChain = decision.continue;
        chainSource = decision.source === "gemini" ? "gemini" : "fallback";
        chainReason = decision.source === "gemini" ? decision.reason : undefined;
        if (decision.source === "gemini") {
          this.emit(
            "systemEvent",
            `GEMINI: chain ${shouldChain ? "continues" : "pauses"}${decision.reason ? ` — ${decision.reason}` : ""}`
          );
        }
      } else {
        shouldChain = Math.random() < this.CHAIN_REACTION_PROBABILITY;
        chainSource = "fallback";
        chainReason = shouldChain ? "random fallback (80%)" : "random fallback (stopped)";
      }
    }

    this.recorder?.recordChain({
      afterSpeakerId: agentId,
      afterSpeaker: speaker?.name ?? agentId,
      afterTranscript: transcript,
      chainTurnCount: this.chainTurnCount,
      addresseeKind,
      addresseeName,
      decision: shouldChain ? "continue" : "pause",
      source: chainSource,
      reason: chainReason,
    });

    if (shouldChain) {
      logger.info(
        "ORCHESTRATOR",
        `${speaker?.name ?? agentId} done — ${isFirstReaction ? "first reaction (guaranteed)" : "chain continues"}`
      );
      this.emit("systemEvent", `CHAIN: reaction #${this.chainTurnCount + 1} pending…`);

      this.transitionTo("IDLE", "agent done");
      this.chainTurnCount++;
      logger.info(
        "ORCHESTRATOR",
        `Chain reaction #${this.chainTurnCount} — reacting in ${this.CHAIN_REACTION_DELAY_MS}ms`
      );

      this.chainTimer = setTimeout(() => {
        this.chainTimer = null;
        if (this.state === "IDLE" && generation === this.selectionGeneration) {
          void this.selectAndTriggerAgent("chain");
        }
      }, this.CHAIN_REACTION_DELAY_MS);
      return;
    }

    logger.info("ORCHESTRATOR", "Chain ended — last speaker will invite human.");
    this.emit("systemEvent", `CHAIN: conversation paused`);
    this.chainTurnCount = 0;
    this.beginEngagementQuestion(speaker);
  }

  /**
   * Last speaker asks the Human one short question before the playout queue empties.
   */
  private beginEngagementQuestion(agent: AgentRecord | undefined): void {
    if (!agent || agent.session.state === "CLOSED") {
      this.transitionTo("IDLE", "no engagement");
      this.emit("humanTurnReady");
      return;
    }

    this.engagementTurnActive = true;
    this.activeAgent = agent;
    this.transitionTo("AGENT_SPEAKING", `${agent.name} engagement`);

    this.recorder?.recordRouting({
      context: "engagement",
      selectedSpeakerId: agent.id,
      selectedSpeaker: agent.name,
      source: "engagement",
      reason: "engagement question for human",
      label: `ENGAGE: ${agent.name} → question for human`,
    });

    logger.info("ORCHESTRATOR", `${agent.name} posing engagement question to human.`);
    this.emit("systemEvent", `ENGAGE: ${agent.name} → question for human`);
    this.emit("humanInvited", agent.id, agent.name);
    this.emit("agentSpeakingStart", agent.id, agent.name);

    const hooks = this.recorder?.beginAgentTurn(agent.id, agent.name, "engagement", false);
    agent.session.triggerResponse(
      this.composeTurnInstructions(
        agent,
        `Ask ${this.humanName} one short, direct question that invites them to speak next — ` +
          "something specific to what was just discussed. " +
          `Address ${this.humanName} as "you" or "${this.humanName}" — never say "${agent.name}" as if you are talking to yourself. ` +
          "Keep it conversational and under 12 seconds. Only your voice; no meta commentary.",
        { skipDissent: true }
      ),
      { hooks }
    );
  }

  // ─── FSM helpers ─────────────────────────────────────────────────────────────

  private transitionTo(next: OrchestratorState, reason?: string): void {
    const prev = this.state;
    if (prev === next) return;

    this.state = next;
    logger.state(prev, next, reason);
    this.emit("stateChange", prev, next);
    this.emit("systemEvent", `STATE: ${prev} → ${next}${reason ? ` (${reason})` : ""}`);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private clearChainTimer(): void {
    if (this.chainTimer) {
      clearTimeout(this.chainTimer);
      this.chainTimer = null;
    }
  }

  private clearTranscriptFallbackTimer(): void {
    if (this.transcriptFallbackTimer) {
      clearTimeout(this.transcriptFallbackTimer);
      this.transcriptFallbackTimer = null;
    }
  }

  private findAgent(agentId: string): AgentRecord | undefined {
    return this.agents.find((a) => a.id === agentId);
  }

  // ─── Getters ─────────────────────────────────────────────────────────────────

  public getState(): OrchestratorState {
    return this.state;
  }

  public getActiveAgentId(): string | null {
    return this.activeAgent?.id ?? null;
  }

  public getAgentSpeakStats(): Array<{ id: string; name: string; speakCount: number }> {
    return this.agents.map(({ id, name, speakCount }) => ({ id, name, speakCount }));
  }

  public destroy(): void {
    this.clearSilenceTimer();
    this.clearChainTimer();
    this.clearTranscriptFallbackTimer();
    this.removeAllListeners();
  }
}
