import { EventEmitter } from "events";
import type { AgentSession } from "./agentSession";
import { logger } from "../lib/logger";

export type MixerEvents = {
  clientAudio: [base64Chunk: string, agentId: string];
};

export class AudioMixer extends EventEmitter {
  private sessions: Map<string, AgentSession> = new Map();
  private stats: Map<string, { sent: number; received: number }> = new Map();
  private statsInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.startStatsReporter();
  }

  public registerAgent(session: AgentSession): void {
    this.sessions.set(session.agentId, session);
    this.stats.set(session.agentId, { sent: 0, received: 0 });

    session.on("audioDelta", (base64Chunk: string, agentId: string) => {
      this.routeAgentAudio(base64Chunk, agentId);
    });

    logger.info("MIXER", `Registered agent: ${session.agentId}`);
  }

  public unregisterAgent(agentId: string): void {
    this.sessions.delete(agentId);
    this.stats.delete(agentId);
    logger.info("MIXER", `Unregistered agent: ${agentId}`);
  }

  public routeHumanAudio(_audioBuffer: Buffer): void {
    // Pipeline mode: human audio is transcribed separately, not forwarded to agents
  }

  private routeAgentAudio(base64Chunk: string, sourceAgentId: string): void {
    this.emit("clientAudio", base64Chunk, sourceAgentId);

    const decoded = Buffer.from(base64Chunk, "base64");
    const sourceStat = this.stats.get(sourceAgentId);
    if (sourceStat) {
      sourceStat.received += decoded.byteLength;
    }
  }

  public clearAllBuffers(): void {
    for (const [, session] of this.sessions) {
      session.clearAudioBuffer();
    }
    logger.info("MIXER", "All agent input buffers cleared.");
  }

  public clearAgentBuffer(agentId: string): void {
    const session = this.sessions.get(agentId);
    if (session) {
      session.clearAudioBuffer();
    }
  }

  private startStatsReporter(): void {
    this.statsInterval = setInterval(() => {
      if (this.sessions.size === 0) return;

      for (const [, stat] of this.stats) {
        stat.sent = 0;
        stat.received = 0;
      }
    }, 10_000);

    this.statsInterval.unref();
  }

  public destroy(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    this.removeAllListeners();
    this.sessions.clear();
    this.stats.clear();
  }
}
