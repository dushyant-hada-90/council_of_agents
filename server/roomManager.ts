import WebSocket from "ws";
import type { MeetingConfig } from "../lib/agents/types";
import { buildAgentConfigs } from "../lib/agents/roster";
import { PipelineAgentSession } from "./pipelineAgentSession";
import type { AgentSession } from "./agentSession";
import { AudioMixer } from "./audioMixer";
import { Orchestrator, InterruptPlaybackReport } from "./orchestrator";
import { SessionRecorder } from "./sessionRecorder";
import { TranscriptPersister, registerPersister, unregisterPersister } from "./transcriptPersister";
import { AudioUsageTracker } from "./audioUsageTracker";
import { S3AudioUploader, setMeetingS3Prefix } from "./s3AudioUploader";
import { logger } from "./logger";
import { bumpPlayoutEpoch, getPlayoutEpoch, resetPlayoutEpoch } from "./playoutEpoch";
import { resolveHumanTranscript, type HumanTranscriptMeta } from "./humanTranscribe";
import { getSupabaseAdmin } from "../lib/supabase/admin";
import { getEnv } from "../lib/env";
import { PCM16_BYTES_PER_MS } from "./agentSession";

export interface RoomClient {
  ws: WebSocket;
  userId: string | null;
}

export type MeetingEndReason = "user" | "idle" | "audio_limit";

export interface ConferenceRoomCallbacks {
  onPermanentEnd: (reason: MeetingEndReason) => void;
}

export class ConferenceRoom {
  readonly meetingId: string;
  readonly config: MeetingConfig;
  readonly agents: ReturnType<typeof buildAgentConfigs>;

  private mixer: AudioMixer;
  private orchestrator: Orchestrator;
  private agentSessions: AgentSession[] = [];
  private sessionRecorder: SessionRecorder;
  private transcriptPersister: TranscriptPersister;
  private audioUsage: AudioUsageTracker | null = null;
  private s3Uploader: S3AudioUploader;
  private client: RoomClient | null = null;
  private pendingAudioLimitEnd = false;

  private humanAudioChunks: Buffer[] = [];
  private humanTranscriptDelivered = false;
  private humanTranscriptStatus = "idle";
  private readonly idleTimeoutMs: number;
  private readonly onPermanentEnd: (reason: MeetingEndReason) => void;
  private lastActivityAt = Date.now();
  private idleCheckTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(
    meetingConfig: MeetingConfig,
    callbacks: ConferenceRoomCallbacks,
    idleTimeoutMs: number
  ) {
    this.onPermanentEnd = callbacks.onPermanentEnd;
    this.idleTimeoutMs = idleTimeoutMs;
    this.meetingId = meetingConfig.meetingId;
    this.config = meetingConfig;
    this.agents = buildAgentConfigs(meetingConfig.humanName, meetingConfig.agents, {
      topic: meetingConfig.topic,
      goal: meetingConfig.goal,
      context: meetingConfig.context,
      instructions: meetingConfig.instructions,
    });

    this.mixer = new AudioMixer();
    this.sessionRecorder = new SessionRecorder(
      meetingConfig.meetingId,
      this.agents.map((a) => ({ id: a.id, name: a.name })),
      meetingConfig.humanName
    );

    const env = getEnv();
    this.transcriptPersister = new TranscriptPersister(
      meetingConfig.meetingId,
      meetingConfig.userId,
      env.TRANSCRIPT_FLUSH_INTERVAL_MS
    );
    registerPersister(this.transcriptPersister);

    this.s3Uploader = new S3AudioUploader(meetingConfig.meetingId);
    void setMeetingS3Prefix(meetingConfig.meetingId);

    if (meetingConfig.isGuest) {
      this.audioUsage = new AudioUsageTracker({
        isGuest: true,
        meetingId: meetingConfig.meetingId,
        guestIp: meetingConfig.guestIp,
        initialSeconds: meetingConfig.initialSpokenSeconds,
        callbacks: {
          onWarning: (remaining) => {
            this.sendToClient({
              type: "AUDIO_LIMIT_WARNING",
              remainingSeconds: remaining,
              timestamp: Date.now(),
            });
          },
          onLimitReached: () => {
            this.pendingAudioLimitEnd = true;
            if (this.orchestrator.getState() !== "AGENT_SPEAKING") {
              this.requestUserEnd("audio_limit");
            }
          },
        },
      });
    }

    this.orchestrator = new Orchestrator(this.mixer, this.sessionRecorder, {
      humanName: meetingConfig.humanName,
      maxAiTurnsBeforeHuman: meetingConfig.maxAiTurnsBeforeHuman,
    });
    this.orchestrator.setTranscriptStatusProvider(() => this.humanTranscriptStatus);

    this.wireOrchestrator();
    this.wireMixer();
    this.initAgentSessions();
    this.markMeetingActive();
    this.startIdleWatch();
  }

  touchActivity(): void {
    if (this.destroyed) return;
    this.lastActivityAt = Date.now();
  }

  private startIdleWatch(): void {
    this.touchActivity();
    this.idleCheckTimer = setInterval(() => {
      if (this.destroyed) return;
      if (Date.now() - this.lastActivityAt >= this.idleTimeoutMs) {
        logger.info("ROOM", `Meeting ${this.meetingId} idle for ${this.idleTimeoutMs}ms — ending`);
        this.requestUserEnd("idle");
      }
    }, 30_000);
  }

  private async markMeetingActive(): Promise<void> {
    try {
      const supabase = getSupabaseAdmin();
      let query = supabase.from("meetings").select("started_at").eq("id", this.meetingId);
      if (this.config.userId) {
        query = query.eq("user_id", this.config.userId);
      } else {
        query = query.eq("is_guest", true);
      }

      const { data: row } = await query.maybeSingle();
      const startedAt = (row as { started_at?: string | null } | null)?.started_at;
      const patch: Record<string, string> = { status: "active" };
      if (!startedAt) {
        patch.started_at = new Date().toISOString();
      }

      await supabase.from("meetings").update(patch as never).eq("id", this.meetingId);
    } catch (err) {
      logger.warn("ROOM", `Failed to mark meeting active: ${(err as Error).message}`);
    }
  }

  private wireOrchestrator(): void {
    this.orchestrator.on("stopClientAudio", (epoch: number) => {
      this.sendToClient({ type: "STOP_CLIENT_AUDIO", epoch });
    });

    this.orchestrator.on("agentSpeakingStart", (agentId: string, agentName: string) => {
      if (this.audioUsage?.shouldBlockNewTurns()) return;
      this.sendToClient({ type: "AGENT_SPEAKING_START", agentId, agentName });
    });

    this.orchestrator.on("agentSpeakingEnd", (agentId: string) => {
      this.sendToClient({ type: "AGENT_SPEAKING_END", agentId });
      if (this.pendingAudioLimitEnd) {
        this.requestUserEnd("audio_limit");
      }
    });

    this.orchestrator.on(
      "transcript",
      (agentId, agentName, text, partial, addressee, replyTo) => {
        this.persistTranscript({
          speakerId: agentId,
          speakerName: agentName,
          speakerType: agentId === "human" ? "human" : "agent",
          message: text,
          timestamp: Date.now(),
          partial,
          metadata: { addressee, replyTo },
        });
        this.sendToClient({
          type: "TRANSCRIPT",
          agentId,
          agentName,
          text,
          timestamp: Date.now(),
          partial: !!partial,
          addressee,
          replyTo,
        });
      }
    );

    this.orchestrator.on("stateChange", (prev, next) => {
      this.sendToClient({ type: "STATE_CHANGE", prev, next, timestamp: Date.now() });
    });

    this.orchestrator.on("humanInvited", (agentId, agentName) => {
      this.sendToClient({ type: "HUMAN_INVITED", agentId, agentName, timestamp: Date.now() });
    });

    this.orchestrator.on("humanTurnReady", () => {
      this.sendToClient({ type: "HUMAN_TURN_READY", timestamp: Date.now() });
    });
  }

  private wireMixer(): void {
    this.mixer.on("clientAudio", (base64Chunk: string, agentId: string) => {
      if (!this.client?.ws || this.client.ws.readyState !== WebSocket.OPEN) return;
      this.touchActivity();

      const audioBytes = Buffer.from(base64Chunk, "base64");
      this.audioUsage?.addAgentAudio(audioBytes.byteLength);
      this.s3Uploader.appendPcm("agent", agentId, audioBytes);

      const agentIndex = this.agents.findIndex((a) => a.id === agentId);
      const frame = Buffer.allocUnsafe(3 + audioBytes.byteLength);
      frame.writeUInt8(agentIndex >= 0 ? agentIndex : 0, 0);
      frame.writeUInt16LE(getPlayoutEpoch(), 1);
      audioBytes.copy(frame, 3);
      this.client.ws.send(frame, { binary: true });
    });
  }

  private initAgentSessions(): void {
    for (const agentConfig of this.agents) {
      const session = new PipelineAgentSession(
        agentConfig,
        this.agents,
        this.config.humanName
      );
      this.agentSessions.push(session);
      this.mixer.registerAgent(session);
      this.orchestrator.registerAgent(session, agentConfig.name, agentConfig.systemPrompt);
      session.on("transcriptDelta", (delta: string, agentId: string) => {
        this.touchActivity();
        this.sendToClient({
          type: "TRANSCRIPT_DELTA",
          agentId,
          agentName: agentConfig.name,
          delta,
          timestamp: Date.now(),
        });
      });
      session.connect();
    }
  }

  private persistTranscript(entry: {
    speakerId: string;
    speakerName: string;
    speakerType: "human" | "agent";
    message: string;
    timestamp: number;
    partial?: boolean;
    metadata?: Record<string, unknown>;
  }): void {
    if (!entry.message?.trim() || entry.partial) return;
    this.touchActivity();
    this.transcriptPersister.append(entry);
  }

  attachClient(client: RoomClient): void {
    this.client = client;
    this.touchActivity();
    resetPlayoutEpoch();

    const agentMeta = this.agents.map((a) => ({
      id: a.id,
      name: a.name,
      voice: a.voice,
      color: a.color,
    }));

    setTimeout(() => {
      this.sendToClient({
        type: "ROOM_READY",
        agents: agentMeta,
        meetingId: this.meetingId,
        humanName: this.config.humanName,
        isGuest: this.config.isGuest ?? false,
        refinedPrompt: this.config.refinedPrompt,
      });
    }, 200);
  }

  detachClient(): void {
    this.client = null;
    void this.transcriptPersister.flush();
  }

  getClient(): RoomClient | null {
    return this.client;
  }

  /** Drop the current client so the same user/guest can reconnect (e.g. Strict Mode). */
  evictClient(): void {
    const existing = this.client;
    if (!existing) return;
    this.client = null;
    if (existing.ws.readyState === WebSocket.OPEN) {
      try {
        existing.ws.close(1000, "Replaced by new connection");
      } catch {
        /* already closing */
      }
    }
  }

  hasClient(): boolean {
    return this.client !== null && this.client.ws.readyState === WebSocket.OPEN;
  }

  get userId(): string | null {
    return this.config.userId;
  }

  private sendToClient(event: object): void {
    if (this.client?.ws.readyState === WebSocket.OPEN) {
      this.client.ws.send(JSON.stringify(event));
    }
  }

  private deliverHumanTranscript(text: string | null, meta: HumanTranscriptMeta): void {
    if (this.humanTranscriptDelivered) return;
    this.humanTranscriptDelivered = true;
    this.humanTranscriptStatus = meta.detail;

    if (this.audioUsage?.shouldBlockNewTurns()) {
      const blocked: HumanTranscriptMeta = {
        source: "error",
        detail: "guest audio limit reached before transcript could be used",
      };
      this.humanTranscriptStatus = blocked.detail;
      this.orchestrator.onHumanTranscript(null, blocked);
      this.requestUserEnd("audio_limit");
      return;
    }

    this.orchestrator.onHumanTranscript(text, meta);
    if (text?.trim()) {
      this.persistTranscript({
        speakerId: "human",
        speakerName: this.config.humanName,
        speakerType: "human",
        message: text.trim(),
        timestamp: Date.now(),
      });
      this.sendToClient({
        type: "TRANSCRIPT",
        agentId: "human",
        agentName: this.config.humanName,
        text: text.trim(),
        timestamp: Date.now(),
      });
      logger.info("SYSTEM", `Human transcript (${meta.source}): "${text}"`);
    } else {
      logger.warn("SYSTEM", `Human transcript empty (${meta.source}): ${meta.detail}`);
    }
  }

  handleMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      if (this.audioUsage?.shouldBlockNewTurns()) return;
      this.touchActivity();
      const audioBuf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      this.humanAudioChunks.push(audioBuf);
      this.audioUsage?.addHumanAudio(audioBuf.byteLength);
      this.s3Uploader.appendPcm("human", "human", audioBuf);
      this.mixer.routeHumanAudio(audioBuf);
      return;
    }

    let event: { type: string; [key: string]: unknown };
    try {
      event = JSON.parse(data.toString()) as { type: string };
    } catch {
      return;
    }

    switch (event.type) {
      case "START_SPEECH": {
        if (this.audioUsage?.shouldBlockNewTurns()) return;
        this.touchActivity();
        this.humanAudioChunks = [];
        this.humanTranscriptDelivered = false;
        const report = event.playbackReport as InterruptPlaybackReport | undefined;
        const newEpoch = bumpPlayoutEpoch();
        this.sessionRecorder.markPttStart();
        this.orchestrator.onHumanSpeechStart(report, newEpoch);
        break;
      }
      case "END_SPEECH": {
        if (this.audioUsage?.shouldBlockNewTurns()) {
          this.requestUserEnd("audio_limit");
          return;
        }
        this.touchActivity();
        const chunks = this.humanAudioChunks.splice(0);
        this.humanAudioChunks = [];
        const byteCount = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        this.sessionRecorder.markPttEnd(chunks.length, byteCount);
        this.orchestrator.onHumanSpeechEnd();
        this.humanTranscriptStatus = `awaiting Google STT (${chunks.length} chunks, ${byteCount} bytes)`;

        if (chunks.length === 0) {
          this.sessionRecorder.markSttResult(null, "none", "no audio chunks captured on END_SPEECH");
          this.deliverHumanTranscript(null, {
            source: "none",
            detail: "no audio chunks captured on END_SPEECH",
          });
          break;
        }

        this.sessionRecorder.markSttSubmit();
        const captureSampleRate =
          typeof event.captureSampleRate === "number" ? event.captureSampleRate : undefined;
        void resolveHumanTranscript(chunks, { captureSampleRate })
          .then((result) => {
            this.humanTranscriptStatus = result.meta.detail;
            this.sessionRecorder.markSttResult(
              result.text,
              result.meta.source as "google" | "none" | "error",
              result.meta.detail
            );
            this.deliverHumanTranscript(result.text, result.meta);
          })
          .catch((err) => {
            const detail = `transcription promise rejected: ${(err as Error).message}`;
            this.humanTranscriptStatus = detail;
            logger.warn("TRANSCRIBE", detail);
            this.sessionRecorder.markSttResult(null, "error", detail);
            if (!this.humanTranscriptDelivered) {
              this.deliverHumanTranscript(null, { source: "error", detail });
            }
          });
        break;
      }
      case "PING":
        this.touchActivity();
        this.client?.ws.send(JSON.stringify({ type: "PONG", ts: Date.now() }));
        break;
      case "END_MEETING":
        this.requestUserEnd("user");
        break;
    }
  }

  requestUserEnd(reason: MeetingEndReason): void {
    if (this.destroyed) return;
    this.sendToClient({ type: "MEETING_ENDED", reason });
    const ws = this.client?.ws;
    this.detachClient();
    this.onPermanentEnd(reason);
    if (ws && ws.readyState === WebSocket.OPEN) {
      const closeReason =
        reason === "idle"
          ? "Meeting idle timeout"
          : reason === "audio_limit"
            ? "Audio limit reached"
            : "Meeting ended";
      ws.close(1000, closeReason);
    }
  }

  async destroy(options: { markEnded: boolean }): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }

    this.sessionRecorder.flush();
    unregisterPersister(this.transcriptPersister);
    await this.transcriptPersister.destroy();
    await this.audioUsage?.destroy();
    await this.s3Uploader.destroy();

    this.orchestrator.destroy();
    this.mixer.destroy();
    for (const session of this.agentSessions) session.destroy();
    this.agentSessions = [];
    resetPlayoutEpoch();

    if (options.markEnded) {
      try {
        const supabase = getSupabaseAdmin();
        await supabase
          .from("meetings")
          .update({ status: "ended", ended_at: new Date().toISOString() } as never)
          .eq("id", this.meetingId);
      } catch (err) {
        logger.warn("ROOM", `Failed to mark meeting ended: ${(err as Error).message}`);
      }
    }

    logger.info("ROOM", `Room ${this.meetingId} destroyed (markEnded=${options.markEnded})`);
  }
}

export class RoomManager {
  private readonly rooms = new Map<string, ConferenceRoom>();
  private acceptingNewMeetings = true;

  setAcceptingNewMeetings(accept: boolean): void {
    this.acceptingNewMeetings = accept;
  }

  canAcceptNewMeetings(): boolean {
    return this.acceptingNewMeetings;
  }

  getRoom(meetingId: string): ConferenceRoom | undefined {
    return this.rooms.get(meetingId);
  }

  createRoom(config: MeetingConfig): ConferenceRoom {
    if (!this.acceptingNewMeetings) {
      throw new Error("Server is shutting down — not accepting new meetings");
    }
    const existing = this.rooms.get(config.meetingId);
    if (existing) return existing;

    const env = getEnv();
    const room = new ConferenceRoom(
      config,
      {
        onPermanentEnd: (reason) => {
          void this.endMeetingPermanently(config.meetingId, reason);
        },
      },
      env.MEETING_IDLE_TIMEOUT_MS
    );
    this.rooms.set(config.meetingId, room);
    return room;
  }

  async destroyRoom(meetingId: string, options: { markEnded: boolean }): Promise<void> {
    const room = this.rooms.get(meetingId);
    if (!room) return;
    this.rooms.delete(meetingId);
    await room.destroy(options);
  }

  async endMeetingPermanently(meetingId: string, _reason: MeetingEndReason): Promise<void> {
    await this.destroyRoom(meetingId, { markEnded: true });
  }

  async destroyAll(): Promise<void> {
    const ids = [...this.rooms.keys()];
    await Promise.all(ids.map((id) => this.destroyRoom(id, { markEnded: true })));
  }

  get activeRoomCount(): number {
    return this.rooms.size;
  }

  endMeeting(meetingId: string, userId: string): boolean {
    const room = this.rooms.get(meetingId);
    if (!room || room.userId !== userId) return false;
    room.requestUserEnd("user");
    return true;
  }
}

export const roomManager = new RoomManager();
