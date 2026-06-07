import { EventEmitter } from "events";
import type { AgentConfig } from "../lib/agents/types";
import { buildMeetingRoster } from "../lib/agents/roster";
import { generateAgentResponse, type ChatMessage } from "./google/geminiChat";
import { synthesizeSpeech, pcmToBase64Chunks } from "./google/tts";
import { logger } from "./logger";
import { PCM16_BYTES_PER_MS, type SessionState, type AgentSession, type PipelineHooks } from "./agentSession";

/**
 * Pipeline agent session: Gemini Flash (text) → Google TTS (audio).
 */
export class PipelineAgentSession extends EventEmitter implements AgentSession {
  public readonly agentId: string;
  public state: SessionState = "CONNECTING";

  private readonly config: AgentConfig;
  private readonly allAgents: AgentConfig[];
  private readonly humanName: string;
  private isDestroyed = false;
  private abortController: AbortController | null = null;

  private conversationHistory: ChatMessage[] = [];
  private currentTranscriptText = "";
  private lastCompletedTranscript = "";
  private currentResponseAudioBytes = 0;
  private lastCompletedAudioBytes = 0;

  constructor(
    config: AgentConfig,
    allAgents: AgentConfig[],
    humanName = "You"
  ) {
    super();
    this.config = config;
    this.agentId = config.id;
    this.allAgents = allAgents;
    this.humanName = humanName;
  }

  connect(): void {
    if (this.isDestroyed) return;
    this.state = "READY";
    this.emit("ready");
    logger.info("PIPELINE", `${this.agentId} session READY`);
  }

  destroy(): void {
    this.isDestroyed = true;
    this.abortController?.abort();
    this.state = "CLOSED";
    logger.info("PIPELINE", `${this.agentId} session destroyed`);
  }

  appendAudio(_audioBuffer: Buffer): void {
    // No-op in pipeline mode — context via injectTableSpeech text history
  }

  appendAudioBase64(_base64: string): void {
    // No-op in pipeline mode
  }

  clearAudioBuffer(): void {
    // No-op
  }

  injectTableSpeech(speakerLabel: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.conversationHistory.push({
      role: "user",
      text: `${speakerLabel}: ${trimmed}`,
    });
    if (this.conversationHistory.length > 48) {
      this.conversationHistory = this.conversationHistory.slice(-48);
    }
  }

  commitAudioBuffer(): boolean {
    return false;
  }

  triggerResponse(
    extraInstructions?: string,
    options?: { preGeneratedText?: string; hooks?: PipelineHooks }
  ): void {
    if (this.isDestroyed || this.state === "SPEAKING") return;
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    this.state = "SPEAKING";
    this.currentTranscriptText = "";
    this.currentResponseAudioBytes = 0;

    void this.runPipeline(extraInstructions, signal, options?.preGeneratedText, options?.hooks);
  }

  private async runPipeline(
    extraInstructions: string | undefined,
    signal: AbortSignal,
    preGeneratedText?: string,
    hooks?: PipelineHooks
  ): Promise<void> {
    const roster = buildMeetingRoster(this.humanName, this.allAgents);
    const systemPrompt = `${this.config.systemPrompt}\n\n${roster}`;

    try {
      let text: string;
      if (preGeneratedText) {
        text = preGeneratedText.trim();
        // Pre-generated: no Gemini call, text is already available
      } else {
        hooks?.onGeminiStart();
        text = await generateAgentResponse({
          systemPrompt,
          conversationHistory: this.conversationHistory,
          extraInstructions,
        });
        hooks?.onGeminiEnd(text);
      }

      if (signal.aborted || this.isDestroyed) {
        hooks?.onDone("cancelled");
        this.state = "READY";
        return;
      }

      this.currentTranscriptText = text;
      this.lastCompletedTranscript = text;
      this.emit("transcriptDelta", text, this.agentId);
      this.emit("transcriptDone", text, this.agentId);

      hooks?.onTtsStart();
      const pcm = await synthesizeSpeech(text, { voice: this.config.voice });
      hooks?.onTtsEnd(pcm.byteLength);

      if (signal.aborted || this.isDestroyed) {
        hooks?.onDone("cancelled");
        this.state = "READY";
        return;
      }

      this.currentResponseAudioBytes = pcm.byteLength;
      this.lastCompletedAudioBytes = pcm.byteLength;

      const chunks = pcmToBase64Chunks(pcm);
      let isFirst = true;
      for (const chunk of chunks) {
        if (signal.aborted || this.isDestroyed) break;
        if (isFirst) {
          hooks?.onFirstAudioSent();
          isFirst = false;
        }
        this.emit("audioDelta", chunk, this.agentId);
      }
      if (!isFirst) {
        hooks?.onLastAudioSent();
      }

      this.conversationHistory.push({ role: "model", text });

      this.state = "READY";
      hooks?.onDone("completed");
      this.emit("responseDone", "completed", this.agentId);
    } catch (err) {
      if (!signal.aborted) {
        logger.error("PIPELINE", `${this.agentId} pipeline failed: ${(err as Error).message}`);
        this.emit("error", err as Error, this.agentId);
      }
      hooks?.onDone(signal.aborted ? "cancelled" : "failed");
      this.state = "READY";
      this.emit("responseDone", "failed", this.agentId);
    }
  }

  cancelResponse(): void {
    if (this.state !== "SPEAKING") return;
    this.abortController?.abort();
    this.state = "READY";
    this.currentTranscriptText = "";
    this.currentResponseAudioBytes = 0;
  }

  forceCancelResponse(): void {
    this.cancelResponse();
  }

  rollbackAssistantAudio(_mode: "delete" | "truncate", _audioEndMs?: number): void {
    if (this.conversationHistory.length > 0 &&
        this.conversationHistory[this.conversationHistory.length - 1]?.role === "model") {
      this.conversationHistory.pop();
    }
    this.currentTranscriptText = "";
    this.currentResponseAudioBytes = 0;
  }

  getLastTranscript(): string {
    return this.lastCompletedTranscript || this.currentTranscriptText;
  }

  getTranscriptUpToMs(audioEndMs: number): string {
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
}
