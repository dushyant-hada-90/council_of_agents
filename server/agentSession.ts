import { EventEmitter } from "events";

export type SessionState = "CONNECTING" | "READY" | "SPEAKING" | "CLOSED";

/**
 * Timing hooks injected into PipelineAgentSession per turn.
 * Captured by SessionRecorder to build the per-turn latency breakdown.
 */
export interface PipelineHooks {
  /** Called immediately before the Gemini chat request (unused — all speech is pre-generated). */
  onGeminiStart(): void;
  /** Called when Gemini returns the spoken text. */
  onGeminiEnd(text: string): void;
  /** Called immediately before the TTS synthesis request. */
  onTtsStart(): void;
  /** Called when TTS returns PCM audio. */
  onTtsEnd(pcmBytes: number): void;
  /** Called when the first audio chunk is emitted to the client. */
  onFirstAudioSent(): void;
  /** Called after the last audio chunk is emitted to the client. */
  onLastAudioSent(): void;
  /** Called when the pipeline completes (or fails/cancels). */
  onDone(status: "completed" | "cancelled" | "failed"): void;
}

/** Common interface for agent voice sessions (pipeline mode). */
export interface AgentSession extends EventEmitter {
  readonly agentId: string;
  state: SessionState;
  connect(): void;
  destroy(): void;
  appendAudio(audioBuffer: Buffer): void;
  appendAudioBase64(base64: string): void;
  clearAudioBuffer(): void;
  injectTableSpeech(speakerLabel: string, text: string): void;
  commitAudioBuffer(): boolean;
  triggerResponse(options: { preGeneratedText: string; hooks?: PipelineHooks }): void;
  cancelResponse(): void;
  forceCancelResponse(): void;
  rollbackAssistantAudio(mode: "delete" | "truncate", audioEndMs?: number): void;
  getLastTranscript(): string;
  getTranscriptUpToMs(audioEndMs: number): string;
}

export { PCM16_BYTES_PER_MS } from "../lib/helpers/audio/pcm";
