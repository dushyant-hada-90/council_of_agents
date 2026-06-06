import WebSocket from "ws";
import { EventEmitter } from "events";
import { AgentConfig, buildMeetingRoster } from "../personalities/agents";
import { logger } from "./logger";

// ─── OpenAI Realtime GA API types (partial) ──────────────────────────────────

interface SessionUpdateEvent {
  type: "session.update";
  session: {
    type: "realtime";
    model: string;
    instructions: string;
    output_modalities: string[];
    audio: {
      input: {
        format: { type: "audio/pcm"; rate: 24000 };
        transcription: { model: string };
        turn_detection: null; // CRITICAL: disabled — orchestrator manages turns
      };
      output: {
        format: { type: "audio/pcm"; rate: 24000 };
        voice: string;
      };
    };
  };
}

interface InputAudioBufferAppendEvent {
  type: "input_audio_buffer.append";
  audio: string; // base64-encoded PCM16
}

interface InputAudioBufferClearEvent {
  type: "input_audio_buffer.clear";
}

interface InputAudioBufferCommitEvent {
  type: "input_audio_buffer.commit";
}

interface ResponseCreateEvent {
  type: "response.create";
  response: {
    output_modalities?: string[];
    instructions?: string;
  };
}

interface ResponseCancelEvent {
  type: "response.cancel";
}

interface ConversationItemTruncateEvent {
  type: "conversation.item.truncate";
  item_id: string;
  content_index: number;
  audio_end_ms: number;
}

interface ConversationItemDeleteEvent {
  type: "conversation.item.delete";
  item_id: string;
}

interface ConversationItemCreateEvent {
  type: "conversation.item.create";
  item: {
    type: "message";
    role: "user";
    content: Array<{ type: "input_text"; text: string }>;
  };
}

type OutboundEvent =
  | SessionUpdateEvent
  | InputAudioBufferAppendEvent
  | InputAudioBufferClearEvent
  | InputAudioBufferCommitEvent
  | ResponseCreateEvent
  | ResponseCancelEvent
  | ConversationItemTruncateEvent
  | ConversationItemDeleteEvent
  | ConversationItemCreateEvent;

/** PCM16 mono 24kHz: bytes → milliseconds */
const PCM16_BYTES_PER_MS = 48; // 24000 samples/s × 2 bytes / 1000

// ─── Inbound event types from OpenAI (GA names) ─────────────────────────────

export interface OpenAIAudioDeltaEvent {
  type: "response.output_audio.delta" | "response.audio.delta";
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string; // base64 PCM16
}

export interface OpenAITranscriptDeltaEvent {
  type: "response.output_audio_transcript.delta" | "response.audio_transcript.delta";
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface OpenAITranscriptDoneEvent {
  type: "response.output_audio_transcript.done" | "response.audio_transcript.done";
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  transcript: string;
}

export interface OpenAIResponseDoneEvent {
  type: "response.done";
  response: {
    id: string;
    status: "completed" | "cancelled" | "failed" | "incomplete";
    output: unknown[];
  };
}

export interface OpenAIErrorEvent {
  type: "error";
  error: {
    type: string;
    code: string;
    message: string;
    param: string | null;
    event_id: string | null;
  };
}

// ─── RealtimeSession class ────────────────────────────────────────────────────

export type SessionState = "CONNECTING" | "READY" | "SPEAKING" | "CLOSED";

const DEFAULT_REALTIME_MODEL =
  process.env["OPENAI_REALTIME_MODEL"] ?? "gpt-realtime-2";

/**
 * Wraps a single persistent WebSocket connection to the OpenAI Realtime GA API.
 * Handles session initialization, audio streaming, and event forwarding.
 * turn_detection is always null — the Orchestrator drives all turn-taking.
 */
export class RealtimeSession extends EventEmitter {
  public readonly agentId: string;
  public state: SessionState = "CONNECTING";

  private ws: WebSocket | null = null;
  private readonly config: AgentConfig;
  private readonly apiKey: string;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 3;
  private isDestroyed = false;

  /** Queue events sent before the session was READY */
  private pendingEvents: OutboundEvent[] = [];

  /** Tracks the assistant item produced by the in-flight or last-completed response. */
  private currentItemId: string | null = null;
  private currentContentIndex = 0;
  private currentResponseAudioBytes = 0;
  private lastCompletedItemId: string | null = null;
  private lastCompletedAudioBytes = 0;

  /** Accumulated transcript for the in-flight or last-completed response. */
  private currentTranscriptText = "";
  private lastCompletedTranscript = "";

  /** Uncommitted input audio tracked locally — OpenAI requires ≥100ms before commit. */
  private pendingInputAudioBytes = 0;
  private static readonly MIN_COMMIT_BYTES = PCM16_BYTES_PER_MS * 100;

  constructor(config: AgentConfig, apiKey: string) {
    super();
    this.config = config;
    this.agentId = config.id;
    this.apiKey = apiKey;
  }

  // ─── Public lifecycle ───────────────────────────────────────────────────────

  /** Open the WebSocket connection and initialize the session. */
  public connect(): void {
    if (this.isDestroyed) return;

    const url = `wss://api.openai.com/v1/realtime?model=${DEFAULT_REALTIME_MODEL}`;

    logger.info(
      "SESSION",
      `Connecting ${this.agentId} to OpenAI Realtime GA API (model: ${DEFAULT_REALTIME_MODEL})…`
    );

    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    this.ws.on("open", () => this.handleOpen());
    this.ws.on("message", (data) => this.handleMessage(data));
    this.ws.on("error", (err) => this.handleError(err));
    this.ws.on("close", (code, reason) => this.handleClose(code, reason));
  }

  /** Permanently close this session. */
  public destroy(): void {
    this.isDestroyed = true;
    this.state = "CLOSED";
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close(1000, "Session destroyed");
      this.ws = null;
    }
    logger.info("SESSION", `${this.agentId} session destroyed.`);
  }

  // ─── Audio buffer helpers ───────────────────────────────────────────────────

  /**
   * Append raw PCM16 audio to this agent's input buffer.
   * @param audioBuffer Raw PCM16 bytes (NOT base64 — we encode here).
   */
  public appendAudio(audioBuffer: Buffer): void {
    this.pendingInputAudioBytes += audioBuffer.byteLength;
    const base64 = audioBuffer.toString("base64");
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: base64,
    });
  }

  /**
   * Append base64-encoded PCM16 audio (used when forwarding agent-to-agent audio
   * to avoid double-encoding).
   */
  public appendAudioBase64(base64: string): void {
    const decoded = Buffer.from(base64, "base64");
    this.pendingInputAudioBytes += decoded.byteLength;
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: base64,
    });
  }

  /** Wipe the uncommitted audio input buffer. */
  public clearAudioBuffer(): void {
    this.pendingInputAudioBytes = 0;
    this.sendEvent({ type: "input_audio_buffer.clear" });
    logger.debug("SESSION", `${this.agentId} — input buffer cleared`);
  }

  /**
   * Add another participant's speech to this session's conversation history.
   * Used alongside mix-minus audio so agents retain durable context even when
   * their input buffer was cleared before they spoke.
   */
  public injectTableSpeech(speakerLabel: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `${speakerLabel}: ${trimmed}` }],
      },
    });
    logger.debug("SESSION", `${this.agentId} — table speech from ${speakerLabel}`);
  }

  /**
   * Commit the input audio buffer — required with turn_detection: null before
   * triggering a response so the model has a user turn to respond to.
   */
  public commitAudioBuffer(): boolean {
    if (this.pendingInputAudioBytes < RealtimeSession.MIN_COMMIT_BYTES) {
      logger.debug(
        "SESSION",
        `${this.agentId} — skipping commit (${(this.pendingInputAudioBytes / PCM16_BYTES_PER_MS).toFixed(1)}ms buffered)`
      );
      return false;
    }
    this.pendingInputAudioBytes = 0;
    logger.wsEvent("SENT", this.agentId, "input_audio_buffer.commit");
    this.sendEvent({ type: "input_audio_buffer.commit" });
    return true;
  }

  // ─── Turn-taking helpers ────────────────────────────────────────────────────

  /**
   * Trigger a response generation. Commits buffered audio first (required when
   * VAD is disabled), then fires response.create.
   */
  public triggerResponse(extraInstructions?: string): void {
    logger.wsEvent("SENT", this.agentId, "response.create", {
      hasExtraInstructions: !!extraInstructions,
    });
    logger.startTimer(`response_latency_${this.agentId}`);
    this.state = "SPEAKING";
    this.currentTranscriptText = "";

    // Commit only when mix-minus audio is present; otherwise rely on conversation history + instructions.
    this.commitAudioBuffer();

    this.sendEvent({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        ...(extraInstructions ? { instructions: extraInstructions } : {}),
      },
    });
  }

  /** Cancel an in-progress response mid-stream. */
  public cancelResponse(): void {
    if (this.state !== "SPEAKING") return;
    logger.wsEvent("SENT", this.agentId, "response.cancel");
    this.sendEvent({ type: "response.cancel" });
    this.state = "READY";
    this.resetCurrentResponseTracking();
  }

  /**
   * Force-cancel even if state is uncertain (used during human interrupt).
   */
  public forceCancelResponse(): void {
    if (this.state === "SPEAKING") {
      this.cancelResponse();
    }
  }

  /**
   * Remove assistant audio from this session's conversation history.
   * - `delete`: entire unheard response (queued on client, never played)
   * - `truncate`: partial response heard by human — keep only audioEndMs
   */
  public rollbackAssistantAudio(mode: "delete" | "truncate", audioEndMs?: number): void {
    const itemId = this.currentItemId ?? this.lastCompletedItemId;
    if (!itemId) return;

    if (mode === "delete") {
      logger.info("SESSION", `${this.agentId} — deleting unheard assistant item ${itemId}`);
      this.sendEvent({ type: "conversation.item.delete", item_id: itemId });
    } else if (mode === "truncate" && audioEndMs !== undefined && audioEndMs > 0) {
      const clampedMs = Math.min(
        audioEndMs,
        Math.floor((this.currentResponseAudioBytes || this.lastCompletedAudioBytes) / PCM16_BYTES_PER_MS)
      );
      logger.info(
        "SESSION",
        `${this.agentId} — truncating assistant item ${itemId} at ${clampedMs}ms`
      );
      this.sendEvent({
        type: "conversation.item.truncate",
        item_id: itemId,
        content_index: this.currentContentIndex,
        audio_end_ms: clampedMs,
      });
    }

    this.lastCompletedItemId = null;
    this.lastCompletedAudioBytes = 0;
    this.resetCurrentResponseTracking();
  }

  /**
   * Return the portion of the current/last transcript that corresponds to
   * audioEndMs of generated source audio (used when the human interrupts).
   */
  /** Full transcript of the agent's most recently completed response. */
  public getLastTranscript(): string {
    return this.lastCompletedTranscript || this.currentTranscriptText;
  }

  public getTranscriptUpToMs(audioEndMs: number): string {
    const text = this.currentTranscriptText || this.lastCompletedTranscript;
    const bytes = this.currentResponseAudioBytes || this.lastCompletedAudioBytes;
    if (!text || bytes <= 0 || audioEndMs <= 0) return "";

    const totalMs = Math.floor(bytes / PCM16_BYTES_PER_MS);
    if (totalMs <= 0) return "";

    const ratio = Math.min(1, audioEndMs / totalMs);
    if (ratio >= 0.995) return text;

    let cutLen = Math.floor(text.length * ratio);
    if (cutLen < text.length) {
      const lastSpace = text.lastIndexOf(" ", cutLen);
      if (lastSpace > cutLen * 0.5) cutLen = lastSpace;
    }

    const partial = text.slice(0, cutLen).trim();
    return partial ? `${partial}…` : "";
  }

  private resetCurrentResponseTracking(): void {
    this.currentItemId = null;
    this.currentContentIndex = 0;
    this.currentResponseAudioBytes = 0;
    this.currentTranscriptText = "";
  }

  // ─── Private WebSocket handlers ─────────────────────────────────────────────

  private handleOpen(): void {
    logger.info("SESSION", `${this.agentId} — WebSocket connected. Initializing session…`);
    this.reconnectAttempts = 0;

    const sessionUpdate: SessionUpdateEvent = {
      type: "session.update",
      session: {
        type: "realtime",
        model: DEFAULT_REALTIME_MODEL,
        instructions: `${this.config.systemPrompt}\n\n${buildMeetingRoster()}`,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: null,
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: this.config.voice,
          },
        },
      },
    };

    this.sendRaw(JSON.stringify(sessionUpdate));
    logger.wsEvent("SENT", this.agentId, "session.update", {
      voice: this.config.voice,
      turn_detection: null,
      api: "GA",
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    let event: Record<string, unknown>;

    try {
      event = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      logger.error("SESSION", `${this.agentId} — failed to parse event`, data.toString().slice(0, 200));
      return;
    }

    const eventType = event["type"] as string;
    logger.wsEvent("RECV", this.agentId, eventType);

    switch (eventType) {
      case "session.created":
      case "session.updated":
        this.state = "READY";
        this.emit("ready");
        this.flushPendingEvents();
        logger.info("SESSION", `${this.agentId} — session READY (voice: ${this.config.voice})`);
        break;

      // GA event names (with beta fallbacks for safety)
      case "response.output_audio.delta":
      case "response.audio.delta": {
        const e = event as unknown as OpenAIAudioDeltaEvent;
        if (e.item_id) this.currentItemId = e.item_id;
        if (e.content_index !== undefined) this.currentContentIndex = e.content_index;
        this.currentResponseAudioBytes += Buffer.from(e.delta, "base64").length;
        this.emit("audioDelta", e.delta, this.agentId);
        break;
      }

      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        const e = event as unknown as OpenAITranscriptDeltaEvent;
        this.currentTranscriptText += e.delta;
        this.emit("transcriptDelta", e.delta, this.agentId);
        break;
      }

      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        const e = event as unknown as OpenAITranscriptDoneEvent;
        this.currentTranscriptText = e.transcript;
        this.lastCompletedTranscript = e.transcript;
        logger.info("SESSION", `${this.agentId} — transcript done: "${e.transcript.slice(0, 80)}…"`);
        this.emit("transcriptDone", e.transcript, this.agentId);
        break;
      }

      case "response.done": {
        const e = event as unknown as OpenAIResponseDoneEvent;
        const status = e.response?.status ?? "unknown";
        logger.logLatency("SESSION", `response_latency_${this.agentId}`);
        logger.info("SESSION", `${this.agentId} — response.done (status: ${status})`);
        this.state = "READY";
        if (this.currentItemId) {
          this.lastCompletedItemId = this.currentItemId;
          this.lastCompletedAudioBytes = this.currentResponseAudioBytes;
          if (this.currentTranscriptText) {
            this.lastCompletedTranscript = this.currentTranscriptText;
          }
        }
        this.emit("responseDone", status, this.agentId);
        break;
      }

      case "error": {
        const e = event as unknown as OpenAIErrorEvent;
        const err = new Error(`OpenAI error [${e.error.code}]: ${e.error.message}`);
        logger.error("SESSION", `${this.agentId} — OpenAI error`, e.error);
        this.emit("error", err, this.agentId);
        break;
      }

      default:
        logger.debug("SESSION", `${this.agentId} — unhandled event type: ${eventType}`);
    }
  }

  private handleError(err: Error): void {
    logger.error("SESSION", `${this.agentId} — WebSocket error: ${err.message}`);
    this.emit("error", err, this.agentId);
  }

  private handleClose(code: number, reason: Buffer): void {
    const reasonStr = reason.toString() || "(no reason)";
    logger.warn("SESSION", `${this.agentId} — WebSocket closed. Code: ${code}, Reason: ${reasonStr}`);
    this.state = "CLOSED";

    if (!this.isDestroyed && this.reconnectAttempts < this.maxReconnectAttempts) {
      const delay = 1000 * Math.pow(2, this.reconnectAttempts);
      this.reconnectAttempts++;
      logger.warn(
        "SESSION",
        `${this.agentId} — reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
      );
      setTimeout(() => this.connect(), delay);
    } else {
      this.emit("closed", this.agentId);
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private sendEvent(event: OutboundEvent): void {
    if (this.state === "CONNECTING") {
      this.pendingEvents.push(event);
      return;
    }
    this.sendRaw(JSON.stringify(event));
  }

  private sendRaw(payload: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn("SESSION", `${this.agentId} — attempted to send on non-open socket`);
      return;
    }
    this.ws.send(payload);
  }

  private flushPendingEvents(): void {
    if (this.pendingEvents.length === 0) return;
    logger.debug("SESSION", `${this.agentId} — flushing ${this.pendingEvents.length} queued events`);
    for (const event of this.pendingEvents) {
      this.sendRaw(JSON.stringify(event));
    }
    this.pendingEvents = [];
  }
}
