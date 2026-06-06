import WebSocket from "ws";
import { EventEmitter } from "events";
import { logger } from "./logger";

/** Realtime model for the WebSocket connection (not the transcription model). */
const DEFAULT_REALTIME_MODEL =
  process.env["OPENAI_REALTIME_MODEL"] ?? "gpt-realtime-2";

/**
 * Input transcription model on a realtime session (not the WS ?model= param).
 * gpt-realtime-whisper requires type:transcription sessions; on realtime WS use mini-transcribe.
 */
const DEFAULT_TRANSCRIPTION_MODEL =
  process.env["OPENAI_TRANSCRIPTION_MODEL"] ?? "gpt-4o-mini-transcribe";

/** PCM16 mono 24kHz — OpenAI requires ≥100ms before commit */
const PCM16_BYTES_PER_MS = 48;
const MIN_COMMIT_BYTES = PCM16_BYTES_PER_MS * 100;

/**
 * Lightweight Realtime WS session dedicated to human speech-to-text.
 * Streams PCM16 as the human speaks and emits the final transcript on commit
 * (~300ms with gpt-realtime-whisper + minimal delay vs batch Whisper).
 */
export class HumanTranscriptionSession extends EventEmitter {
  public state: "CONNECTING" | "READY" | "CLOSED" = "CONNECTING";

  private ws: WebSocket | null = null;
  private readonly apiKey: string;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 3;
  private isDestroyed = false;
  private pendingAudio: Array<{ type: "input_audio_buffer.append"; audio: string }> = [];
  private pendingInputAudioBytes = 0;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  public connect(): void {
    if (this.isDestroyed) return;

    const url = `wss://api.openai.com/v1/realtime?model=${DEFAULT_REALTIME_MODEL}`;

    logger.info(
      "TRANSCRIBE",
      `Connecting human transcription session (realtime: ${DEFAULT_REALTIME_MODEL}, transcribe: ${DEFAULT_TRANSCRIPTION_MODEL})…`
    );

    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    this.ws.on("open", () => this.handleOpen());
    this.ws.on("message", (data) => this.handleMessage(data));
    this.ws.on("error", (err) => this.handleError(err));
    this.ws.on("close", (code, reason) => this.handleClose(code, reason));
  }

  public destroy(): void {
    this.isDestroyed = true;
    this.state = "CLOSED";
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close(1000, "Session destroyed");
      this.ws = null;
    }
    logger.info("TRANSCRIBE", "Human transcription session destroyed.");
  }

  public appendAudio(audioBuffer: Buffer): void {
    this.pendingInputAudioBytes += audioBuffer.byteLength;
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: audioBuffer.toString("base64"),
    });
  }

  public clearAudioBuffer(): void {
    this.pendingInputAudioBytes = 0;
    this.sendEvent({ type: "input_audio_buffer.clear" });
  }

  /** Commit buffered audio — transcription events follow asynchronously. */
  public commitAudioBuffer(): boolean {
    if (this.pendingInputAudioBytes < MIN_COMMIT_BYTES) {
      logger.debug(
        "TRANSCRIBE",
        `Skipping commit — only ${(this.pendingInputAudioBytes / PCM16_BYTES_PER_MS).toFixed(1)}ms buffered`
      );
      return false;
    }
    this.pendingInputAudioBytes = 0;
    logger.wsEvent("SENT", "human-transcribe", "input_audio_buffer.commit");
    this.sendEvent({ type: "input_audio_buffer.commit" });
    return true;
  }

  /**
   * Commit buffered audio and wait for the final transcript (or timeout / error).
   * Returns null when commit is skipped, transcription is empty, or realtime fails.
   */
  public commitAndWaitForTranscript(timeoutMs: number): Promise<string | null> {
    if (this.state !== "READY") return Promise.resolve(null);

    const committed = this.commitAudioBuffer();
    if (!committed) return Promise.resolve(null);

    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off("transcriptDone", onDone);
        this.off("error", onError);
      };

      const onDone = (text: string | null) => {
        cleanup();
        resolve(text?.trim() || null);
      };

      const onError = () => {
        cleanup();
        resolve(null);
      };

      const timer = setTimeout(() => {
        cleanup();
        logger.warn("TRANSCRIBE", `Realtime transcript timed out after ${timeoutMs}ms`);
        resolve(null);
      }, timeoutMs);

      this.once("transcriptDone", onDone);
      this.once("error", onError);
    });
  }

  private handleOpen(): void {
    this.reconnectAttempts = 0;

    const sessionUpdate = {
      type: "session.update",
      session: {
        type: "realtime",
        model: DEFAULT_REALTIME_MODEL,
        instructions:
          "Human speech transcription side-channel. Never generate responses or speak.",
        output_modalities: ["text"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: {
              model: DEFAULT_TRANSCRIPTION_MODEL,
              language: "en",
            },
            turn_detection: null,
          },
        },
      },
    };

    this.sendRaw(JSON.stringify(sessionUpdate));
    logger.wsEvent("SENT", "human-transcribe", "session.update", {
      type: "realtime",
      realtimeModel: DEFAULT_REALTIME_MODEL,
      transcriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      logger.error("TRANSCRIBE", "Failed to parse event", data.toString().slice(0, 200));
      return;
    }

    const eventType = event["type"] as string;
    logger.wsEvent("RECV", "human-transcribe", eventType);

    switch (eventType) {
      case "session.created":
      case "session.updated":
        this.state = "READY";
        this.flushPendingAudio();
        this.emit("ready");
        logger.info("TRANSCRIBE", "Human transcription session READY");
        break;

      case "conversation.item.input_audio_transcription.delta": {
        const delta = String(event["delta"] ?? "");
        if (delta) this.emit("transcriptDelta", delta);
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const transcript = String(event["transcript"] ?? "").trim();
        logger.info("TRANSCRIBE", `Transcript done: "${transcript.slice(0, 80)}${transcript.length > 80 ? "…" : ""}"`);
        this.emit("transcriptDone", transcript || null);
        break;
      }

      case "error": {
        const errObj = event["error"] as { message?: string; code?: string } | undefined;
        const err = new Error(
          `Transcription error [${errObj?.code ?? "unknown"}]: ${errObj?.message ?? "unknown"}`
        );
        logger.error("TRANSCRIBE", err.message);
        this.emit("error", err);
        break;
      }

      default:
        logger.debug("TRANSCRIBE", `Unhandled event: ${eventType}`);
    }
  }

  private handleError(err: Error): void {
    logger.error("TRANSCRIBE", `WebSocket error: ${err.message}`);
    this.emit("error", err);
  }

  private handleClose(code: number, reason: Buffer): void {
    const reasonStr = reason.toString() || "(no reason)";
    logger.warn("TRANSCRIBE", `WebSocket closed. Code: ${code}, Reason: ${reasonStr}`);
    this.state = "CLOSED";

    if (!this.isDestroyed && this.reconnectAttempts < this.maxReconnectAttempts) {
      const delay = 1000 * Math.pow(2, this.reconnectAttempts);
      this.reconnectAttempts++;
      setTimeout(() => this.connect(), delay);
    } else {
      this.emit("closed");
    }
  }

  private sendEvent(event: { type: string; audio?: string }): void {
    if (this.state === "CONNECTING") {
      if (event.type === "input_audio_buffer.append" && event.audio) {
        this.pendingAudio.push({
          type: "input_audio_buffer.append",
          audio: event.audio,
        });
      }
      return;
    }
    this.sendRaw(JSON.stringify(event));
  }

  private sendRaw(payload: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn("TRANSCRIBE", "Attempted send on non-open socket");
      return;
    }
    this.ws.send(payload);
  }

  private flushPendingAudio(): void {
    if (this.pendingAudio.length === 0) return;
    for (const event of this.pendingAudio) {
      this.sendRaw(JSON.stringify(event));
    }
    this.pendingAudio = [];
  }
}
