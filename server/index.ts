import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import WebSocket, { WebSocketServer } from "ws";

import { AGENTS } from "../personalities/agents";
import { RealtimeSession } from "./realtimeSession";
import { HumanTranscriptionSession } from "./humanTranscriptionSession";
import { AudioMixer } from "./audioMixer";
import { Orchestrator, InterruptPlaybackReport } from "./orchestrator";
import { SessionRecorder } from "./sessionRecorder";
import { logger } from "./logger";
import { bumpPlayoutEpoch, getPlayoutEpoch, resetPlayoutEpoch } from "./playoutEpoch";
import { resolveHumanTranscript } from "./humanTranscribe";

// ─── Environment ──────────────────────────────────────────────────────────────

const API_KEY = process.env["OPENAI_API_KEY"];
if (!API_KEY) {
  logger.error("SYSTEM", "OPENAI_API_KEY is not set. Create a .env file with your key.");
  process.exit(1);
}

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);

// Project root: coa/ — works for both ts-node (server/) and compiled (dist/server/)
const PROJECT_ROOT = __dirname.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(__dirname, "../..")
  : path.resolve(__dirname, "..");
const CLIENT_DIR = path.join(PROJECT_ROOT, "client");

// ─── Express + HTTP server ────────────────────────────────────────────────────

const app = express();
const httpServer = http.createServer(app);

// Serve the /client directory as static files
app.use(express.static(CLIENT_DIR));

// Fallback: serve index.html for any unmatched route
app.get("*", (_req, res) => {
  res.sendFile(path.join(CLIENT_DIR, "index.html"));
});

// ─── WebSocket gateway (browser ↔ server) ────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

/**
 * A single "room" is active at a time (one human + 5 agents).
 * In a production scenario you'd support multiple rooms, but for this
 * demo we keep one global mixer + orchestrator.
 */
let mixer: AudioMixer | null = null;
let orchestrator: Orchestrator | null = null;
let agentSessions: RealtimeSession[] = [];
let humanTranscription: HumanTranscriptionSession | null = null;
let sessionRecorder: SessionRecorder | null = null;
let activeClientWs: WebSocket | null = null;

/** PCM16 buffered during PTT — used for batch fallback when realtime transcription fails. */
let humanAudioChunks: Buffer[] = [];
let humanTranscriptDelivered = false;

function deliverHumanTranscript(text: string | null, source: string): void {
  if (humanTranscriptDelivered) return;
  humanTranscriptDelivered = true;

  orchestrator?.onHumanTranscript(text);
  if (text?.trim()) {
    logger.info("SYSTEM", `Human transcript (${source}): "${text}"`);
    sendToClient({
      type: "TRANSCRIPT",
      agentId: "human",
      agentName: "Dushyant",
      text: text.trim(),
      timestamp: Date.now(),
    });
  }
}

/** Send a JSON message to the browser client, if connected. */
function sendToClient(event: object): void {
  if (activeClientWs && activeClientWs.readyState === WebSocket.OPEN) {
    activeClientWs.send(JSON.stringify(event));
  }
}

/** Push a line to the client event log (backend-authoritative only). */
function sendSystemEvent(message: string): void {
  sendToClient({ type: "SYSTEM_EVENT", message, timestamp: Date.now() });
}

/** Tear down all agent sessions and reset room state. */
function destroyRoom(): void {
  const artifactPath = sessionRecorder?.flush();
  if (artifactPath) {
    sendSystemEvent(`SESSION: replay artifact saved (${artifactPath})`);
  }
  sessionRecorder = null;

  orchestrator?.destroy();
  mixer?.destroy();
  for (const session of agentSessions) {
    session.destroy();
  }
  humanTranscription?.destroy();
  agentSessions = [];
  humanTranscription = null;
  orchestrator = null;
  mixer = null;
  resetPlayoutEpoch();
  logger.info("SYSTEM", "Room destroyed and resources freed.");
}

/** Initialize the conference room: create mixer, orchestrator, and 5 agent sessions. */
function initRoom(): void {
  destroyRoom(); // clean up any previous room

  logger.info("SYSTEM", "Initializing conference room…");

  mixer = new AudioMixer();
  sessionRecorder = new SessionRecorder(
    AGENTS.map((a) => ({ id: a.id, name: a.name }))
  );
  orchestrator = new Orchestrator(mixer, process.env.GROQ_API_KEY, sessionRecorder);

  // ── Wire orchestrator → client UI events ─────────────────────────────────

  orchestrator.on("stopClientAudio", (epoch: number) => {
    logger.gatewayEvent("OUT", "STOP_CLIENT_AUDIO", { epoch });
    sendSystemEvent(`AUDIO: client playout stopped (epoch ${epoch})`);
    sendToClient({ type: "STOP_CLIENT_AUDIO", epoch });
  });

  orchestrator.on("agentSpeakingStart", (agentId: string, agentName: string) => {
    logger.gatewayEvent("OUT", "AGENT_SPEAKING_START", { agentId, agentName });
    sendToClient({ type: "AGENT_SPEAKING_START", agentId, agentName });
  });

  orchestrator.on("agentSpeakingEnd", (agentId: string) => {
    logger.gatewayEvent("OUT", "AGENT_SPEAKING_END", { agentId });
    sendToClient({ type: "AGENT_SPEAKING_END", agentId });
  });

  orchestrator.on(
    "transcript",
    (
      agentId: string,
      agentName: string,
      text: string,
      partial?: boolean,
      addressee?: { kind: string; name?: string },
      replyTo?: { kind: string; name: string }
    ) => {
      logger.gatewayEvent("OUT", "TRANSCRIPT", { agentId, text: text.slice(0, 80), partial, addressee, replyTo });
      sendToClient({
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

  orchestrator.on("systemEvent", (message: string) => {
    sendSystemEvent(message);
  });

  orchestrator.on("stateChange", (prev: string, next: string) => {
    sendToClient({ type: "STATE_CHANGE", prev, next, timestamp: Date.now() });
  });

  orchestrator.on("humanInvited", (agentId: string, agentName: string) => {
    sendToClient({ type: "HUMAN_INVITED", agentId, agentName, timestamp: Date.now() });
  });

  orchestrator.on("humanTurnReady", () => {
    sendToClient({ type: "HUMAN_TURN_READY", timestamp: Date.now() });
  });

  // ── Wire mixer → client audio forwarding ─────────────────────────────────

  mixer.on("clientAudio", (base64Chunk: string, agentId: string) => {
    if (activeClientWs && activeClientWs.readyState === WebSocket.OPEN) {
      // Binary frame: [agentIndex (1)][playoutEpoch (2, LE)][PCM16 bytes…]
      // Stale pre-interrupt chunks carry an old epoch and are dropped by the client.
      const agentIndex = AGENTS.findIndex((a) => a.id === agentId);
      const audioBytes = Buffer.from(base64Chunk, "base64");
      const frame = Buffer.allocUnsafe(3 + audioBytes.byteLength);
      frame.writeUInt8(agentIndex >= 0 ? agentIndex : 0, 0);
      frame.writeUInt16LE(getPlayoutEpoch(), 1);
      audioBytes.copy(frame, 3);
      activeClientWs.send(frame, { binary: true });
    }
  });

  // ── Create 5 agent sessions ───────────────────────────────────────────────

  for (const agentConfig of AGENTS) {
    const session = new RealtimeSession(agentConfig, API_KEY!);
    agentSessions.push(session);
    mixer.registerAgent(session);
    orchestrator.registerAgent(session, agentConfig.name);

    session.on("ready", () => {
      sendSystemEvent(`AGENT: ${agentConfig.name} session ready`);
    });

    session.on("closed", (agentId: string) => {
      logger.warn("SYSTEM", `Agent ${agentId} session closed permanently.`);
      sendSystemEvent(`OFFLINE: Agent ${agentId} disconnected`);
    });

    session.connect();
  }

  // ── Dedicated Realtime transcription session (streams as human speaks) ───

  humanTranscription = new HumanTranscriptionSession(API_KEY!);

  humanTranscription.on("ready", () => {
    sendSystemEvent("TRANSCRIBE: human Realtime session ready");
  });

  humanTranscription.on("transcriptDelta", (delta: string) => {
    sendToClient({
      type: "HUMAN_TRANSCRIPT_PARTIAL",
      text: delta,
      timestamp: Date.now(),
    });
  });

  humanTranscription.on("error", (err: Error) => {
    logger.warn("SYSTEM", `Human transcription error: ${err.message}`);
  });

  humanTranscription.connect();

  // ── Send agent metadata to client for UI initialization ──────────────────

  const agentMeta = AGENTS.map((a) => ({
    id: a.id,
    name: a.name,
    voice: a.voice,
    color: a.color,
  }));

  sendSystemEvent("ROOM: initializing conference");

  // Defer slightly to give client time to process the ROOM_READY message
  setTimeout(() => {
    sendToClient({ type: "ROOM_READY", agents: agentMeta });
    sendSystemEvent(`ROOM: ${agentMeta.length} agents online`);
    logger.info("SYSTEM", "Room ready. Sent ROOM_READY to client.");
  }, 200);
}

// ─── WebSocket connection handler ─────────────────────────────────────────────

wss.on("connection", (ws: WebSocket, req) => {
  const ip = req.socket.remoteAddress ?? "unknown";
  logger.info("GATEWAY", `New WebSocket connection from ${ip}`);

  // Only allow one active client at a time in this demo
  if (activeClientWs && activeClientWs.readyState === WebSocket.OPEN) {
    logger.warn("GATEWAY", "Rejecting second client — room already occupied.");
    ws.close(4001, "Room is occupied.");
    return;
  }

  activeClientWs = ws;
  sendSystemEvent(`CONNECTED: client joined (${ip})`);
  logger.startTimer("room_init");
  initRoom();
  logger.logLatency("GATEWAY", "room_init");

  // ── Handle messages from the browser ───────────────────────────────────────

  ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) {
      // Binary message = raw PCM16 microphone audio from the human
      const audioBuf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

      humanAudioChunks.push(audioBuf);
      if (humanTranscription?.state === "READY") {
        humanTranscription.appendAudio(audioBuf);
      }

      if (mixer) {
        mixer.routeHumanAudio(audioBuf);
      }
    } else {
      // Text message = control events from the client UI
      let event: { type: string; [key: string]: unknown };
      try {
        event = JSON.parse(data.toString()) as { type: string };
      } catch {
        logger.warn("GATEWAY", "Received malformed JSON from client");
        return;
      }

      logger.gatewayEvent("IN", event["type"]);

      switch (event["type"]) {
        case "START_SPEECH": {
          humanAudioChunks = [];
          humanTranscriptDelivered = false;
          humanTranscription?.clearAudioBuffer();
          const report = event["playbackReport"] as InterruptPlaybackReport | undefined;
          const newEpoch = bumpPlayoutEpoch();
          if (report) {
            const parts: string[] = [];
            if (report.partial) {
              parts.push(
                `partial=${report.partial.audioEndMs}ms@${report.partial.agentId}`
              );
            }
            if (report.fullyHeard.length) {
              parts.push(`heard=[${report.fullyHeard.join(",")}]`);
            }
            if (report.unheard.length) {
              parts.push(`unheard=[${report.unheard.join(",")}]`);
            }
            sendSystemEvent(`PTT: interrupt (${parts.join(", ")})`);
          } else {
            sendSystemEvent("PTT: human speaking started");
          }
          orchestrator?.onHumanSpeechStart(report, newEpoch);
          break;
        }

        case "END_SPEECH": {
          sendSystemEvent("PTT: human released");
          sessionRecorder?.markHumanPttEnd();
          orchestrator?.onHumanSpeechEnd();

          const chunksToTranscribe = humanAudioChunks.splice(0);
          humanAudioChunks = [];

          void resolveHumanTranscript(chunksToTranscribe, {
            realtimeSession: humanTranscription,
            groqApiKey: process.env.GROQ_API_KEY,
            openaiApiKey: API_KEY!,
          })
            .then(({ text, source }) => {
              deliverHumanTranscript(text, source);
            })
            .catch((err) => {
              const msg = `Human transcription error: ${(err as Error).message}`;
              logger.error("SYSTEM", msg);
              sendSystemEvent(`ERROR: ${msg}`);
              if (!humanTranscriptDelivered) deliverHumanTranscript(null, "error");
            });
          break;
        }

        case "HUMAN_TRANSCRIPT":
          // Fallback: client-side transcript (kept for compatibility)
          sendToClient({
            type: "TRANSCRIPT",
            agentId: "human",
            agentName: "Dushyant",
            text: event["text"] as string,
            timestamp: Date.now(),
          });
          break;

        case "LATENCY_REPORT": {
          const latencyMs = event["latencyMs"] as number;
          if (typeof latencyMs === "number" && latencyMs >= 0) {
            sendSystemEvent(`LATENCY: ${latencyMs} ms to first audio (client)`);
          }
          break;
        }

        case "PING":
          ws.send(JSON.stringify({ type: "PONG", ts: Date.now() }));
          break;

        default:
          logger.warn("GATEWAY", `Unknown client event type: ${event["type"]}`);
      }
    }
  });

  ws.on("close", (code, reason) => {
    logger.info("GATEWAY", `Client disconnected. Code: ${code}, Reason: ${reason.toString() || "(none)"}`);
    activeClientWs = null;
    destroyRoom();
  });

  ws.on("error", (err) => {
    logger.error("GATEWAY", `Client WebSocket error: ${err.message}`);
  });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  logger.info("SYSTEM", `Received ${signal} — shutting down gracefully…`);
  destroyRoom();
  httpServer.close(() => {
    logger.info("SYSTEM", "HTTP server closed. Bye!");
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  logger.info("SYSTEM", `COA Voice Conference running at http://localhost:${PORT}`);
  logger.info("SYSTEM", `WebSocket endpoint: ws://localhost:${PORT}/ws`);
  logger.info("SYSTEM", `${AGENTS.length} agents configured: ${AGENTS.map((a) => a.name).join(", ")}`);
});
