import { EventEmitter } from "events";
import { AgentSession } from "./agentSession";
import { AudioMixer } from "./audioMixer";
import { logger } from "../lib/logger";
import type { MaxAiTurnsBeforeHuman } from "../lib/agents/types";
import { InterruptPlaybackReport } from "./conferenceTypes";
import { SessionRecorder } from "./sessionRecorder";
import {
  ConversationTurn,
  pickSpeakerAndRespondWithGemini,
  requestHandoffWithGemini,
} from "../lib/pipeline/nextSpeakerRouter";
import type { LiveMeetingMetadata } from "../lib/prompts/prompts";
import type { HumanTranscriptMeta } from "../lib/pipeline/humanTranscribe";
import { getEnv } from "../lib/env";

// ─── FSM State definitions ────────────────────────────────────────────────────

export type OrchestratorState =
  | "IDLE"           // No one is speaking. Waiting for human input.
  | "HUMAN_SPEAKING" // Human is actively transmitting audio.
  | "DECIDING"       // Human stopped; silence timeout pending; selecting next agent.
  | "AGENT_SPEAKING"; // An agent is generating audio and streaming it.

// ─── Events emitted to the client gateway ────────────────────────────────────

export type { InterruptPlaybackReport } from "./conferenceTypes";

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
  /** Engagement question done — Human's turn to speak. Optional STT failure notice. */
  humanTurnReady: [sttNotice?: string];
};

// ─── Agent selection bookkeeping ─────────────────────────────────────────────

interface AgentRecord {
  id: string;
  name: string;
  session: AgentSession;
  systemPrompt: string;
  roleSummary: string;
  peerProfile: string;
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

  /** Silence duration before agent selection after human transcript (ms). */
  private readonly silenceTimeoutMs: number;

  /**
   * Delay before a chain-reaction agent speaks (ms).
   */
  private readonly CHAIN_REACTION_DELAY_MS = 900;

  /**
   * Agents that completed response.done in the current round (since human last spoke).
   * Used on interrupt to roll back unheard assistant context.
   */
  private agentsCompletedThisRound: string[] = [];

  /** Waiting for human STT before picking who responds. */
  private awaitingHumanTranscript = false;

  /** Fallback if transcription is slow or never delivered. */
  private transcriptFallbackTimer: NodeJS.Timeout | null = null;
  private readonly transcriptFallbackMs = getEnv().HUMAN_STT_TIMEOUT_MS;
  private transcriptStatusProvider: (() => string) | null = null;

  /** Last human utterance from STT. */
  private lastHumanTranscript: string | null = null;

  /** Follow-up turn where the last speaker invites the human with a pre-generated handoff line. */
  private handoffTurnActive = false;

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

  private readonly meetingTopic: string;
  private readonly meetingGoal: string;
  private readonly meetingContext: string;
  private readonly meetingInstructions: string;

  /** Max agent-only turns before inviting human participation. */
  private readonly maxAiTurnsBeforeHuman: MaxAiTurnsBeforeHuman;

  /** Agent turns since human last spoke (excluding handoff invite). */
  private aiTurnsSinceHuman = 0;

  /** Bumped on interrupt so stale async Gemini picks are ignored. */
  private selectionGeneration = 0;

  /** Prevents overlapping selectAndTriggerAgent runs (duplicate Gemini calls). */
  private selectionInProgress = false;

  /** Whether the in-flight agent turn is replying to the human or continuing a chain. */
  private activeTurnContext: "human_turn" | "chain" = "chain";
  /** Agent id the active chain turn is reacting to (if chain). */
  private replyChainFromId: string | null = null;

  constructor(
    mixer: AudioMixer,
    recorder?: SessionRecorder,
    options?: {
      humanName?: string;
      maxAiTurnsBeforeHuman?: MaxAiTurnsBeforeHuman;
      topic?: string;
      goal?: string;
      context?: string;
      instructions?: string;
    }
  ) {
    super();
    this.mixer = mixer;
    this.routingEnabled = true;
    this.recorder = recorder ?? null;
    this.humanName = options?.humanName ?? "You";
    this.meetingTopic = options?.topic ?? "";
    this.meetingGoal = options?.goal ?? "";
    this.meetingContext = options?.context ?? "";
    this.meetingInstructions = options?.instructions ?? "";
    this.maxAiTurnsBeforeHuman = options?.maxAiTurnsBeforeHuman ?? getEnv().MAX_AI_TURNS_BEFORE_HUMAN;
    this.silenceTimeoutMs = getEnv().POST_TRANSCRIPT_SILENCE_MS;
    logger.info("ORCHESTRATOR", "Gemini next-speaker router enabled");
  }

  /** RoomManager supplies live STT status for timeout fallback logs. */
  public setTranscriptStatusProvider(provider: () => string): void {
    this.transcriptStatusProvider = provider;
  }

  // ─── Agent registration ─────────────────────────────────────────────────────

  public registerAgent(
    session: AgentSession,
    name: string,
    systemPrompt = "",
    roleSummary = "",
    peerProfile = ""
  ): void {
    const record: AgentRecord = {
      id: session.agentId,
      name,
      session,
      systemPrompt,
      roleSummary,
      peerProfile,
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
        const replyTo = this.buildReplyToMeta();
        this.recorder?.recordTurn({
          speakerId: agentId,
          speaker: agent.name,
          role: "agent",
          text: text.trim(),
          replyTo,
        });
        this.emit("transcript", agentId, agent.name, text, false, undefined, replyTo);
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
    this.handoffTurnActive = false;
    this.lastHumanTranscript = null;
    this.aiTurnsSinceHuman = 0;
    this.agentsCompletedThisRound = [];
    this.selectionGeneration++;

    if (this.selectionInProgress) {
      this.selectionInProgress = false;
    }

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
    this.handoffTurnActive = false;

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
  public onHumanSpeechEnd(sttTimeoutMs?: number): void {
    if (this.state !== "HUMAN_SPEAKING") return;

    const timeoutMs = sttTimeoutMs ?? this.transcriptFallbackMs;
    logger.info(
      "ORCHESTRATOR",
      `Human speech END — awaiting transcript before selecting responder… (STT timeout ${timeoutMs}ms)`
    );
    this.agentsCompletedThisRound = [];
    this.awaitingHumanTranscript = true;
    this.transitionTo("DECIDING", "human released PTT");

    this.clearTranscriptFallbackTimer();
    this.transcriptFallbackTimer = setTimeout(() => {
      this.transcriptFallbackTimer = null;
      if (!this.awaitingHumanTranscript || this.state !== "DECIDING") return;

      this.awaitingHumanTranscript = false;
      const status = this.transcriptStatusProvider?.() ?? "STT status unknown";
      logger.warn(
        "ORCHESTRATOR",
        `Transcript fallback after ${timeoutMs}ms — selecting responder without text. ${status}`
      );
      this.recorder?.markSttTimedOut();
      this.scheduleAgentSelection();
    }, timeoutMs);
  }

  /**
   * Called when Google STT returns the human's utterance (or a failure/empty result).
   * Appends the utterance to conversation history; Gemini routes the next speaker.
   */
  public onHumanTranscript(text: string | null, meta?: HumanTranscriptMeta): void {
    if (!this.awaitingHumanTranscript || this.state !== "DECIDING") return;

    this.awaitingHumanTranscript = false;
    this.clearTranscriptFallbackTimer();

    if (!text?.trim()) {
      if (meta) {
        logger.warn("ORCHESTRATOR", `Human transcript empty (${meta.source}): ${meta.detail}`);
      }
      this.lastHumanTranscript = null;
      this.transitionTo("IDLE", "empty transcript");
      const detail = meta?.detail?.trim();
      const notice =
        detail && /no audio|too short|silent/i.test(detail)
          ? `STT: ${detail}`
          : "STT: no transcript — try again";
      this.emit("systemEvent", notice);
      this.emit("humanTurnReady", notice);
      return;
    }

    this.lastHumanTranscript = text;
    this.appendConversationTurn("human", "human", this.humanName, text);
    this.recorder?.recordTurn({
      speakerId: "human",
      speaker: this.humanName,
      role: "human",
      text: text.trim(),
    });
    this.scheduleAgentSelection();
  }

  private scheduleAgentSelection(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      void this.selectAndTriggerAgent("human_turn");
    }, this.silenceTimeoutMs);
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

  private buildMeetingMetadata(agents: AgentRecord[]): LiveMeetingMetadata {
    return {
      humanName: this.humanName,
      topic: this.meetingTopic,
      goal: this.meetingGoal,
      context: this.meetingContext,
      instructions: this.meetingInstructions,
      agents: agents.map((a) => ({
        name: a.name,
        systemPrompt: a.systemPrompt,
        roleSummary: a.roleSummary,
        peerProfile: a.peerProfile,
      })),
    };
  }

  private isolateAgentInput(selected: AgentRecord): void {
    for (const agent of this.agents) {
      if (agent.id !== selected.id) {
        agent.session.clearAudioBuffer();
      }
    }
  }

  // ─── Selection engine ────────────────────────────────────────────────────────

  /** Clear uncommitted human audio on every agent except the one about to speak. */
  private async selectAndTriggerAgent(
    selectionContext: "human_turn" | "chain" = "human_turn",
    options?: {
      afterHuman?: boolean;
      chainRecord?: {
        afterSpeakerId: string;
        afterSpeaker: string;
        afterTranscript: string;
      };
    }
  ): Promise<void> {
    if (this.selectionInProgress) {
      logger.warn(
        "ORCHESTRATOR",
        `Duplicate selection blocked (context=${selectionContext}, gen=${this.selectionGeneration})`
      );
      return;
    }

    if (this.agents.some((a) => a.session.state === "SPEAKING")) {
      logger.warn(
        "ORCHESTRATOR",
        `Selection blocked — agent still generating (context=${selectionContext})`
      );
      return;
    }

    this.selectionInProgress = true;
    const generation = this.selectionGeneration;

    try {
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
    let geminiPickReason: string | undefined;
    let preGeneratedText: string | undefined;

    const afterHuman =
      options?.afterHuman ?? selectionContext === "human_turn";

    if (this.routingEnabled) {
      this.emit("systemEvent", `GEMINI: routing + generating response…`);
      this.recorder?.markRoutingStart(selectionContext);
      const pick = await pickSpeakerAndRespondWithGemini({
        humanName: this.humanName,
        turns: this.conversationTurns,
        candidates: readyAgents.map((a) => ({
          id: a.id,
          name: a.name,
          systemPrompt: a.systemPrompt,
          roleSummary: a.roleSummary,
          peerProfile: a.peerProfile,
        })),
        meetingMetadata: this.buildMeetingMetadata(readyAgents),
        afterHuman,
        lastSpeakerId: this.lastFinishedSpeakerId ?? undefined,
        lastTranscript: options?.chainRecord?.afterTranscript,
      });

      if (generation !== this.selectionGeneration) return;

      if (pick.source === "gemini" && pick.kind === "pause") {
        const record = options?.chainRecord;
        if (record) {
          this.recorder?.recordChain({
            afterSpeakerId: record.afterSpeakerId,
            afterSpeaker: record.afterSpeaker,
            afterTranscript: record.afterTranscript,
            chainTurnCount: this.aiTurnsSinceHuman,
            addresseeKind: "everyone",
            decision: "pause",
            source: "gemini",
            reason: pick.reason,
          });
        }
        this.emit(
          "systemEvent",
          `GEMINI: chain pauses${pick.reason ? ` — ${pick.reason}` : ""}`
        );
        this.playHandoffLine(
          this.findAgent(record?.afterSpeakerId ?? this.lastFinishedSpeakerId ?? ""),
          pick.handoff
        );
        return;
      }

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
          this.activeAgent = null;
          this.transitionTo("IDLE", "gemini human turn");
          this.emit("humanTurnReady");
          this.lastHumanTranscript = null;
          return;
        }
        logger.warn(
          "ORCHESTRATOR",
          `Gemini routed to ${this.humanName} after ${this.humanName} spoke (invalid on human_turn)${pick.reason ? ` — ${pick.reason}` : ""}`
        );
      }

      if (pick.source === "gemini" && pick.kind === "agent") {
        const agent = this.findAgent(pick.agentId);
        if (agent && readyAgents.some((a) => a.id === agent.id)) {
          selectedAgent = agent;
          geminiPickReason = pick.reason;
          preGeneratedText = pick.response;
          selectionLabel = `GEMINI: ${agent.name}${pick.reason ? ` — ${pick.reason}` : ""}`;
          if (!afterHuman && options?.chainRecord) {
            this.recorder?.recordChain({
              afterSpeakerId: options.chainRecord.afterSpeakerId,
              afterSpeaker: options.chainRecord.afterSpeaker,
              afterTranscript: options.chainRecord.afterTranscript,
              chainTurnCount: this.aiTurnsSinceHuman,
              addresseeKind: "everyone",
              decision: "continue",
              source: "gemini",
              reason: pick.reason,
            });
            this.emit(
              "systemEvent",
              `GEMINI: chain continues${pick.reason ? ` — ${pick.reason}` : ""}`
            );
          }
        }
      } else if (pick.source === "failed") {
        logger.warn(
          "ORCHESTRATOR",
          `Merged turn failed after retries${pick.reason ? `: ${pick.reason}` : ""}`
        );
      }
    }

    if (!selectedAgent || !preGeneratedText?.trim()) {
      if (generation !== this.selectionGeneration) return;
      logger.warn("ORCHESTRATOR", "No valid merged turn result — inviting human.");
      this.emit("systemEvent", "ROUTING: failed — human turn");
      this.transitionTo("IDLE", "routing failed");
      this.emit("humanTurnReady");
      return;
    }

    if (generation !== this.selectionGeneration) return;

    logger.info("ORCHESTRATOR", `Selected agent: ${selectedAgent.name}`);
    this.emit("systemEvent", `SELECTED: ${selectionLabel}`);

    const routingSource = "gemini";
    this.recorder?.recordRouting({
      context: selectionContext,
      selectedSpeakerId: selectedAgent.id,
      selectedSpeaker: selectedAgent.name,
      source: routingSource,
      reason: geminiPickReason,
      label: selectionLabel,
    });

    this.recorder?.markRoutingResult(
      selectedAgent.id,
      selectedAgent.name,
      "merged_gemini",
      geminiPickReason,
      true
    );

    this.isolateAgentInput(selectedAgent);
    this.lastHumanTranscript = null;

    this.triggerAgentSpeech(selectedAgent, preGeneratedText, selectionContext);
    } finally {
      this.selectionInProgress = false;
    }
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
    preGeneratedText: string,
    turnContext: "human_turn" | "chain" = "chain"
  ): void {
    this.activeTurnContext = turnContext;
    this.replyChainFromId = turnContext === "chain" ? this.lastFinishedSpeakerId : null;
    this.activeAgent = agent;
    this.transitionTo("AGENT_SPEAKING", `selected ${agent.name}`);

    agent.speakCount++;
    agent.lastSpokAt = Date.now();

    if (turnContext === "human_turn") {
      this.recorder?.setLatencyWinner(agent.id, agent.name);
    }

    this.emit("agentSpeakingStart", agent.id, agent.name);
    this.emit("systemEvent", `SPEAKING: ${agent.name}`);

    logger.startTimer(`turn_latency_${agent.id}_${agent.speakCount}`);
    const hooks = this.recorder?.beginAgentTurn(agent.id, agent.name, turnContext, true);
    agent.session.triggerResponse({ preGeneratedText, hooks });
  }

  private handleAgentDone(agentId: string): void {
    const speaker = this.findAgent(agentId);
    logger.logLatency("ORCHESTRATOR", `turn_latency_${agentId}_${this.activeAgent?.speakCount ?? 0}`);

    // Handoff invite finished — queue will drain, Human's turn.
    if (this.handoffTurnActive) {
      this.handoffTurnActive = false;
      logger.info("ORCHESTRATOR", `${speaker?.name ?? agentId} finished handoff invite.`);
      this.emit("agentSpeakingEnd", agentId);
      this.emit("systemEvent", `HANDOFF: ${speaker?.name ?? agentId} invited human`);
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

    const transcript = speaker?.session.getLastTranscript() ?? "";
    void this.evaluateChainContinuation(speaker, agentId, transcript);
  }

  private async evaluateChainContinuation(
    speaker: AgentRecord | undefined,
    agentId: string,
    transcript: string
  ): Promise<void> {
    const generation = this.selectionGeneration;

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
        chainTurnCount: this.aiTurnsSinceHuman,
        addresseeKind: "everyone",
        decision: "pause",
        source: "fallback",
        reason: `max AI turns (${this.maxAiTurnsBeforeHuman}) before human`,
      });
      void this.requestHandoffLine(speaker, transcript);
      return;
    }

    logger.info("ORCHESTRATOR", `${speaker?.name ?? agentId} done — chain step pending…`);
    this.emit("systemEvent", `CHAIN: next step pending…`);

    this.transitionTo("IDLE", "agent done");

    const chainRecord = {
      afterSpeakerId: agentId,
      afterSpeaker: speaker?.name ?? agentId,
      afterTranscript: transcript,
    };

    this.chainTimer = setTimeout(() => {
      this.chainTimer = null;
      if (this.state === "IDLE" && generation === this.selectionGeneration) {
        void this.selectAndTriggerAgent("chain", {
          afterHuman: false,
          chainRecord,
        });
      }
    }, this.CHAIN_REACTION_DELAY_MS);
  }

  private async requestHandoffLine(
    agent: AgentRecord | undefined,
    lastTranscript?: string
  ): Promise<void> {
    const generation = this.selectionGeneration;
    if (!agent || agent.session.state === "CLOSED") {
      this.inviteHumanTurn();
      return;
    }

    const readyAgents = this.agents.filter((a) => a.session.state !== "CLOSED");
    const pick = await requestHandoffWithGemini({
      humanName: this.humanName,
      turns: this.conversationTurns,
      candidates: readyAgents.map((a) => ({
        id: a.id,
        name: a.name,
        systemPrompt: a.systemPrompt,
        roleSummary: a.roleSummary,
        peerProfile: a.peerProfile,
      })),
      meetingMetadata: this.buildMeetingMetadata(readyAgents),
      lastSpeakerId: agent.id,
      lastTranscript: lastTranscript ?? agent.session.getLastTranscript() ?? undefined,
    });

    if (generation !== this.selectionGeneration) return;

    if (pick.source === "gemini" && pick.kind === "pause") {
      this.playHandoffLine(agent, pick.handoff);
      return;
    }

    logger.warn("ORCHESTRATOR", "Handoff generation failed — opening human turn.");
    this.inviteHumanTurn();
  }

  private inviteHumanTurn(): void {
    this.activeAgent = null;
    this.transitionTo("IDLE", "human turn");
    this.emit("humanTurnReady");
  }

  private playHandoffLine(agent: AgentRecord | undefined, handoffText: string): void {
    const text = handoffText.trim();
    if (!agent || agent.session.state === "CLOSED" || !text) {
      this.inviteHumanTurn();
      return;
    }

    this.handoffTurnActive = true;
    this.activeAgent = agent;
    this.transitionTo("AGENT_SPEAKING", `${agent.name} handoff`);

    this.recorder?.recordRouting({
      context: "engagement",
      selectedSpeakerId: agent.id,
      selectedSpeaker: agent.name,
      source: "engagement",
      reason: "handoff",
      label: `HANDOFF: ${agent.name} → human`,
    });

    logger.info("ORCHESTRATOR", `${agent.name} inviting human with handoff line.`);
    this.emit("systemEvent", `HANDOFF: ${agent.name} → question for human`);
    this.emit("humanInvited", agent.id, agent.name);
    this.emit("agentSpeakingStart", agent.id, agent.name);

    const hooks = this.recorder?.beginAgentTurn(agent.id, agent.name, "engagement", true);
    agent.session.triggerResponse({ preGeneratedText: text, hooks });
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
