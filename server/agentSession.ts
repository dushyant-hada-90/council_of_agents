import { EventEmitter } from "events";

export type SessionState = "CONNECTING" | "READY" | "SPEAKING" | "CLOSED";

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
  triggerResponse(
    extraInstructions?: string,
    options?: { preGeneratedText?: string }
  ): void;
  cancelResponse(): void;
  forceCancelResponse(): void;
  rollbackAssistantAudio(mode: "delete" | "truncate", audioEndMs?: number): void;
  getLastTranscript(): string;
  getTranscriptUpToMs(audioEndMs: number): string;
}

export const PCM16_BYTES_PER_MS = 48;
