import { EventEmitter } from "events";
import { RealtimeSession } from "./realtimeSession";
import { logger } from "./logger";

/**
 * AudioMixer — implements the Acoustic Mix-Minus routing matrix.
 *
 * Mix-Minus principle:
 *   • Human mic audio → broadcast to ALL 5 agents
 *   • Agent X audio output → sent to client (human) + forwarded to agents 1…5 EXCEPT agent X
 *
 * This lets agents hear each other's tonality, pacing, and emotional cues
 * while preventing a feedback echo loop (no agent hears itself).
 *
 * Note: forwarded audio lands in each session's *uncommitted* input buffer.
 * The orchestrator commits that buffer only when an agent is selected to speak;
 * durable cross-agent memory is synced separately via conversation.item.create.
 *
 * All audio is raw base64-encoded PCM16 at 24kHz mono to match the OpenAI
 * Realtime API's expected format.
 */

export type MixerEvents = {
  /**
   * Emitted when audio from any agent should be forwarded to the human client.
   * Payload: raw base64 PCM16 chunk + agent ID for UI speaking indicator.
   */
  clientAudio: [base64Chunk: string, agentId: string];
};

export class AudioMixer extends EventEmitter {
  /**
   * Map of agentId → RealtimeSession for all registered agents.
   * Populated by calling registerAgent() for each of the 5 agents.
   */
  private sessions: Map<string, RealtimeSession> = new Map();

  /**
   * Tracks per-agent audio throughput counters (bytes sent/received).
   * Reset every 10 seconds by the internal stats timer.
   */
  private stats: Map<string, { sent: number; received: number }> = new Map();
  private statsInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.startStatsReporter();
  }

  // ─── Agent registration ─────────────────────────────────────────────────────

  /** Register a RealtimeSession so the mixer can route audio to/from it. */
  public registerAgent(session: RealtimeSession): void {
    this.sessions.set(session.agentId, session);
    this.stats.set(session.agentId, { sent: 0, received: 0 });

    // Wire up the agent's outbound audio to our routing logic
    session.on("audioDelta", (base64Chunk: string, agentId: string) => {
      this.routeAgentAudio(base64Chunk, agentId);
    });

    logger.info("MIXER", `Registered agent: ${session.agentId}`);
  }

  /** Remove a session from the routing matrix (e.g., on disconnect). */
  public unregisterAgent(agentId: string): void {
    this.sessions.delete(agentId);
    this.stats.delete(agentId);
    logger.info("MIXER", `Unregistered agent: ${agentId}`);
  }

  // ─── Inbound human audio ─────────────────────────────────────────────────────

  /**
   * Receive a chunk of human microphone audio (raw PCM16 bytes) and forward
   * it to every registered agent's input buffer.
   *
   * Called by the server gateway on each binary WebSocket message from the browser.
   */
  public routeHumanAudio(audioBuffer: Buffer): void {
    if (this.sessions.size === 0) return;

    for (const [agentId, session] of this.sessions) {
      if (session.state === "CLOSED") continue;

      session.appendAudio(audioBuffer);

      const stat = this.stats.get(agentId);
      if (stat) stat.sent += audioBuffer.byteLength;

      logger.audioRoute("human", agentId, audioBuffer.byteLength);
    }
  }

  // ─── Outbound agent audio routing ───────────────────────────────────────────

  /**
   * Called when agent `sourceAgentId` emits an audio.delta chunk.
   *
   * Routing rules:
   *   1. Emit `clientAudio` event so the gateway forwards audio to the browser.
   *   2. For every OTHER agent, append this chunk to their input buffer.
   *      This is the "acoustic" part — agents hear each other.
   */
  private routeAgentAudio(base64Chunk: string, sourceAgentId: string): void {
    // 1. Forward to human client
    this.emit("clientAudio", base64Chunk, sourceAgentId);

    // 2. Forward to every other agent's input buffer (Mix-Minus: not to self)
    for (const [agentId, session] of this.sessions) {
      if (agentId === sourceAgentId) continue; // Mix-Minus: skip self
      if (session.state === "CLOSED") continue;

      session.appendAudioBase64(base64Chunk);

      const decoded = Buffer.from(base64Chunk, "base64");
      const stat = this.stats.get(agentId);
      if (stat) stat.sent += decoded.byteLength;

      logger.audioRoute(sourceAgentId, agentId, decoded.byteLength);
    }

    // Update received counter for source agent
    const sourceStat = this.stats.get(sourceAgentId);
    if (sourceStat) {
      sourceStat.received += Buffer.from(base64Chunk, "base64").byteLength;
    }
  }

  // ─── Buffer management ───────────────────────────────────────────────────────

  /**
   * Clear the input audio buffer of ALL agents.
   * Called by the orchestrator when the human starts speaking mid-agent-turn
   * to prevent cross-talk contamination.
   */
  public clearAllBuffers(): void {
    for (const [, session] of this.sessions) {
      session.clearAudioBuffer();
    }
    logger.info("MIXER", "All agent input buffers cleared.");
  }

  /**
   * Clear the input audio buffer of a specific agent.
   */
  public clearAgentBuffer(agentId: string): void {
    const session = this.sessions.get(agentId);
    if (session) {
      session.clearAudioBuffer();
    }
  }

  // ─── Stats reporter ──────────────────────────────────────────────────────────

  private startStatsReporter(): void {
    this.statsInterval = setInterval(() => {
      if (this.sessions.size === 0) return;

      const report: Record<string, { sent: string; received: string }> = {};
      for (const [agentId, stat] of this.stats) {
        report[agentId] = {
          sent: `${(stat.sent / 1024).toFixed(1)} KB`,
          received: `${(stat.received / 1024).toFixed(1)} KB`,
        };
        // Reset
        stat.sent = 0;
        stat.received = 0;
      }

      logger.debug("MIXER", "10s audio stats", report);
    }, 10_000);

    // Don't keep the process alive just for stats
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
