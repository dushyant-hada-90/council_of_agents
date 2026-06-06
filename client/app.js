/**
 * COA Voice Conference — Client Application
 *
 * Responsibilities:
 *   1. WebSocket connection to the Node.js gateway (/ws)
 *   2. Microphone capture → PCM16 24kHz mono → stream to server
 *   3. Incoming binary audio → Web Audio API gapless playback queue
 *   4. UI rendering: queue-synced participant cards, transcript, playout queue viz
 *   5. Push-to-Talk (PTT) button + spacebar shortcut
 *   6. Waveform visualizer on the human mic input
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const WS_URL = `ws://${location.host}/ws`;
const SAMPLE_RATE = 24000;      // OpenAI Realtime API expects 24kHz
const CHANNELS = 1;             // Mono
const BIT_DEPTH = 16;           // PCM16
const PLAYBACK_BUFFER_AHEAD_S = 0.05; // Schedule audio 50ms ahead to prevent gaps
const MAX_TRANSCRIPT_ENTRIES = 100;
const QUEUE_UPDATE_INTERVAL_MS = 250;
const QUEUE_DONE_VISIBLE_S = 0.6;
const PLAYBACK_SPEEDS = [1, 1.5, 2];

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {WebSocket | null} */
let ws = null;

/** @type {AudioContext | null} */
let audioCtx = null;

/** @type {MediaStream | null} */
let micStream = null;

/** @type {ScriptProcessorNode | null} */
let scriptProcessor = null;

/** @type {AnalyserNode | null} */
let analyser = null;

/**
 * Playout authority — single global queue with tracked sources for hard interrupt.
 * nextPlayTime: where the next chunk will be scheduled in AudioContext time.
 * playoutEpoch: must match server frame header byte or chunk is discarded.
 */
let nextPlayTime = 0;
let playoutEpoch = 0;
/** True between local interrupt flush and server STOP_CLIENT_AUDIO epoch confirm. */
let playoutBlocked = false;
/** Global playback speed applied to all agent audio (1, 1.5, or 2). */
let playbackSpeed = 1;
let playbackSpeedIndex = 0;

/** @type {AudioBufferSourceNode[]} */
const activeSources = [];

/**
 * Per-agent scheduled chunks for interrupt reporting.
 * agentId → [{ startAt, durationSec, source }]
 */
const playoutSchedule = new Map();

/** Registered agent metadata: id, name, voice, color */
let agents = [];

/** Map agentId → DOM card element */
const agentCards = new Map();

// ── Audio/UI sync state ────────────────────────────────────────────────────
/**
 * Map agentId → AudioContext time at which that agent's LAST scheduled audio
 * chunk finishes playing. Updated every time a binary audio frame arrives.
 * Used to delay UI updates (speaking indicator off, transcript reveal) until
 * the audio has actually played out — not when the server event fires.
 */
const agentAudioEndTimes = new Map();

/** segmentId → transcript message. */
const segmentTranscripts = new Map();
/** segmentId → transcript DOM node. */
const transcriptDomBySegment = new Map();
/** agentId → DOM node shown before a queue segment exists. */
const pendingTranscriptEntryByAgent = new Map();
/** Transcripts waiting for a matching queue segment to be scheduled. */
const unboundTranscripts = [];
/** Monotonic order key for transcript pane insert position. */
let transcriptSeq = 0;
/** Per-segment playout timers — sole authority for transcript + queue handoff UI. */
const segmentSyncTimers = new Map();

/** Monotonic id for each scheduled audio chunk. */
let queueChunkCounter = 0;
/**
 * Ordered speaker segments — consecutive chunks from the same agent merge into one card.
 * e.g. [Rohan, Priya, Vikram, Priya, Sara, Rohan]
 */
const queueSegments = [];
let queueSegmentCounter = 0;
/** Agent currently posing an engagement question before human's turn. */
let engagementAgentId = null;
/** True only after engagement audio finishes playing — human may speak. */
let humanTurnPending = false;
/** Server signaled human's turn; apply once playout queue drains. */
let pendingHumanTurnFromServer = false;
/** segmentId currently outputting to speakers (audio clock). */
let activeHeardSegmentId = null;

/** Agent id whose interrupt partial transcript was already shown this turn. */
let interruptTranscriptShownFor = null;

/** Latency tracking: time when human released PTT */
let humanEndTime = 0;
let firstAudioFrameReceived = false;

let isMicCapturing = false;
let isPTTActive = false;
let connectionReady = false;

// ─── DOM references (set after DOMContentLoaded) ──────────────────────────────

const overlay           = document.getElementById("overlay");
const overlaySub        = document.getElementById("overlay-sub");
const stateBadge        = document.getElementById("state-badge");
const latencyDisplay    = document.getElementById("latency-display");
const connectionStatus  = document.getElementById("connection-status");
const agentsContainer   = document.getElementById("agents-container");
const transcriptBody    = document.getElementById("transcript-body");
const queueStats        = document.getElementById("queue-stats");
const queueEmpty        = document.getElementById("queue-empty");
const queueChunksEl     = document.getElementById("queue-chunks");
const pttBtn            = document.getElementById("ptt-btn");
const pttLabel          = document.getElementById("ptt-label");
const waveformCanvas    = document.getElementById("waveform-canvas");
const speedBtn          = document.getElementById("speed-btn");
const humanCard         = document.getElementById("human-card");
const humanTurnHint     = document.getElementById("human-turn-hint");

// ─── WebSocket connection ─────────────────────────────────────────────────────

function connectWebSocket() {
  ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    updateConnectionStatus("Connected", "#22c55e");
    hideOverlay();
    connectionReady = true;

    // Start heartbeat to detect stale connections
    startHeartbeat();
  });

  ws.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) {
      handleBinaryAudio(event.data);
    } else {
      handleTextMessage(event.data);
    }
  });

  ws.addEventListener("close", (event) => {
    connectionReady = false;
    stopMicCapture();
    updateConnectionStatus("Disconnected", "#ef4444");
    showOverlay("Connection lost", "Reconnecting in 3s…");
    setTimeout(connectWebSocket, 3000);
  });

  ws.addEventListener("error", () => {
    updateConnectionStatus("Error", "#ef4444");
  });
}

function sendJSON(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

let heartbeatInterval = null;
let lastPongTime = Date.now();

function startHeartbeat() {
  clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    sendJSON({ type: "PING" });
    if (Date.now() - lastPongTime > 10000) {
      ws?.close();
    }
  }, 5000);
}

// ─── Incoming message router ──────────────────────────────────────────────────

function handleTextMessage(rawData) {
  let msg;
  try {
    msg = JSON.parse(rawData);
  } catch {
    return;
  }

  switch (msg.type) {
    case "ROOM_READY":
      handleRoomReady(msg.agents);
      break;

    case "AGENT_SPEAKING_START":
      handleAgentSpeakingStart(msg.agentId, msg.agentName);
      break;

    case "AGENT_SPEAKING_END":
      handleAgentSpeakingEnd(msg.agentId);
      break;

    case "STOP_CLIENT_AUDIO":
      stopPlayback(msg.epoch ?? playoutEpoch + 1);
      break;

    case "TRANSCRIPT":
      handleTranscript(msg);
      break;

    case "STATE_CHANGE":
      handleStateChange(msg.prev, msg.next);
      break;

    case "HUMAN_INVITED":
      handleHumanInvited(msg.agentId, msg.agentName);
      break;

    case "HUMAN_TURN_READY":
      pendingHumanTurnFromServer = true;
      tryActivateHumanTurn();
      break;

    case "PONG":
      lastPongTime = Date.now();
      break;

    case "SYSTEM_EVENT":
      handleSystemEvent(msg.message);
      break;
  }
}

// ─── Room initialization ──────────────────────────────────────────────────────

function handleRoomReady(agentList) {
  agents = agentList;
  renderAgentCards();
  syncSidebarFromQueue();
}

function renderAgentCards() {
  // Clear existing cards (but not the human-card footer, which is outside panel-body)
  agentsContainer.innerHTML = "";
  agentCards.clear();

  for (const agent of agents) {
    const card = createAgentCard(agent);
    agentsContainer.appendChild(card);
    agentCards.set(agent.id, card);
  }
}

function createAgentCard(agent) {
  const initial = agent.name.charAt(0).toUpperCase();

  const card = document.createElement("div");
  card.className = "agent-card";
  card.id = `card-${agent.id}`;
  card.style.setProperty("--agent-color", agent.color);

  card.innerHTML = `
    <div class="agent-avatar" style="background: ${agent.color}">
      ${initial}
      <div class="wave-ring"></div>
    </div>
    <div class="agent-info">
      <div class="agent-name">${escapeHtml(agent.name)}</div>
      <div class="agent-voice">voice: ${escapeHtml(agent.voice)}</div>
      <div class="agent-meta" id="meta-${agent.id}">Listening…</div>
    </div>
    <div class="next-badge">NEXT</div>
    <div class="speaking-badge">SPEAKING</div>
  `;

  return card;
}

// ─── Participant sidebar (playout queue only) ────────────────────────────────

/**
 * Left sidebar speaking / up-next highlights follow the playout queue clock —
 * never server AGENT_SPEAKING_* events or Groq routing.
 */
function syncSidebarFromQueue() {
  const now = audioCtx?.currentTime ?? 0;

  const playingSeg =
    queueSegments.find((seg) => now >= seg.startAt && now < seg.endAt) ?? null;

  let nextSeg = null;
  if (playingSeg) {
    const idx = queueSegments.indexOf(playingSeg);
    nextSeg = queueSegments.slice(idx + 1).find((seg) => seg.endAt > now) ?? null;
  } else {
    nextSeg = queueSegments.find((seg) => seg.startAt > now) ?? null;
  }

  for (const agent of agents) {
    const card = agentCards.get(agent.id);
    const meta = document.getElementById(`meta-${agent.id}`);
    if (!card || !meta) continue;

    card.classList.remove("speaking", "next-speaker");

    if (playingSeg?.agentId === agent.id) {
      card.classList.add("speaking");
      meta.textContent = playingSeg.isEngagement ? "Speaking to you…" : "Speaking…";
    } else if (nextSeg?.agentId === agent.id) {
      card.classList.add("next-speaker");
      meta.textContent = nextSeg.isEngagement ? "Up next → you" : "Up next";
    } else {
      meta.textContent = "Listening…";
    }
  }

  const queueDrained = !hasQueuedAudioAfter(now) && activeSources.length === 0;
  const showHumanTurn = !isPTTActive && (humanTurnPending || (pendingHumanTurnFromServer && queueDrained));

  if (showHumanTurn) {
    humanCard?.classList.add("human-your-turn");
    if (humanTurnHint) {
      humanTurnHint.hidden = false;
      humanTurnHint.textContent = "Your turn — hold to speak";
    }
  } else {
    humanCard?.classList.remove("human-your-turn");
    if (humanTurnHint) {
      humanTurnHint.hidden = true;
      humanTurnHint.textContent = "";
    }
  }
}

function handleSystemEvent(message) {
  if (!message) return;

  if (message.startsWith("GROQ: routing")) {
    _renderSystemTranscriptLine("Groq", "Routing next speaker…");
    return;
  }

  if (message.startsWith("GROQ:") && message.includes("'s turn")) {
    const reason = message.match(/GROQ: .+?'s turn \((.+)\)/)?.[1]?.trim();
    _renderSystemTranscriptLine("Groq", reason ? `Dushyant's turn — ${reason}` : "Dushyant's turn");
    return;
  }

  if (message.startsWith("SELECTED:")) {
    const label = message.slice("SELECTED:".length).trim();
    _renderSystemTranscriptLine("Router", label);
  }
}

// ─── Agent lifecycle (transcript binding only — sidebar is queue-driven) ─────

function handleAgentSpeakingStart(_agentId, _agentName) {
  interruptTranscriptShownFor = null;
  firstAudioFrameReceived = false;
}

function handleAgentSpeakingEnd(agentId) {
  tryBindAllUnboundTranscripts();
  flushUnboundTranscriptsForAgent(agentId);
}

// ─── Binary audio handling & gapless playback ─────────────────────────────────

/**
 * Incoming binary frame from server:
 *   Byte 0: agent index (0–4)
 *   Bytes 1–2: playout epoch (Uint16 LE) — must match client playoutEpoch
 *   Bytes 3…N: raw PCM16 little-endian 24kHz mono
 */
function handleBinaryAudio(arrayBuffer) {
  ensureAudioContext();
  if (!audioCtx || arrayBuffer.byteLength < 4) return;

  const view = new DataView(arrayBuffer);
  const agentIndex = view.getUint8(0);
  const frameEpoch = view.getUint16(1, true);

  if (playoutBlocked || frameEpoch !== playoutEpoch) return;

  const agentId = agents[agentIndex]?.id ?? null;
  const alignedBuffer = arrayBuffer.slice(3);
  const pcm16 = new Int16Array(alignedBuffer);
  if (pcm16.length === 0) return;

  if (!firstAudioFrameReceived && humanEndTime > 0) {
    const firstAudioHeardAt = Date.now();
    const latency = firstAudioHeardAt - humanEndTime;
    latencyDisplay.textContent = `${latency} ms`;
    firstAudioFrameReceived = true;
    sendJSON({
      type: "LATENCY_REPORT",
      latencyMs: latency,
      humanPttReleasedAt: humanEndTime,
      firstAudioHeardAt,
      agentId,
      agentName,
    });
  }

  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / 32768.0;
  }

  const audioBuffer = audioCtx.createBuffer(CHANNELS, float32.length, SAMPLE_RATE);
  audioBuffer.copyToChannel(float32, 0);

  const sourceDurationSec = audioBuffer.duration;
  const effectiveDurationSec = sourceDurationSec / playbackSpeed;

  const startAt = Math.max(audioCtx.currentTime + PLAYBACK_BUFFER_AHEAD_S, nextPlayTime);
  const chunkId = ++queueChunkCounter;
  const agentName = agents.find((a) => a.id === agentId)?.name ?? agentId ?? "?";

  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.playbackRate.value = playbackSpeed;
  source.connect(audioCtx.destination);

  try {
    source.start(startAt);
  } catch (_) {
    return;
  }

  activeSources.push(source);
  source.onended = () => {
    const idx = activeSources.indexOf(source);
    if (idx >= 0) activeSources.splice(idx, 1);
  };

  nextPlayTime = startAt + effectiveDurationSec;

  if (agentId) {
    agentAudioEndTimes.set(agentId, nextPlayTime);
    if (!playoutSchedule.has(agentId)) playoutSchedule.set(agentId, []);
    playoutSchedule.get(agentId).push({
      id: chunkId,
      agentId,
      agentName,
      startAt,
      sourceDurationSec,
      effectiveDurationSec,
      source,
    });

    registerQueueSegment(agentId, agentName, sourceDurationSec, effectiveDurationSec, startAt);
  }
}

function buildInterruptReport() {
  if (!audioCtx) {
    return { fullyHeard: [], partial: null, unheard: [] };
  }

  const now = audioCtx.currentTime;
  const fullyHeard = [];
  const unheard = [];
  let partial = null;

  for (const [agentId, chunks] of playoutSchedule) {
    if (!chunks.length) continue;

    const firstStart = chunks[0].startAt;
    const lastChunk = chunks[chunks.length - 1];
    const lastEnd = lastChunk.startAt + lastChunk.effectiveDurationSec;

    if (lastEnd <= now) {
      fullyHeard.push(agentId);
    } else if (firstStart > now) {
      unheard.push(agentId);
    } else {
      let playedMs = 0;
      for (const c of chunks) {
        const end = c.startAt + c.effectiveDurationSec;
        if (end <= now) {
          playedMs += c.sourceDurationSec * 1000;
        } else if (c.startAt <= now) {
          playedMs += (now - c.startAt) * playbackSpeed * 1000;
        }
      }
      partial = { agentId, audioEndMs: Math.floor(playedMs) };
    }
  }

  return { fullyHeard, partial, unheard };
}

/**
 * Show the portion of an agent transcript that was actually heard before interrupt.
 * Uses buffered full transcript + playout schedule (source audio ms).
 */
function showInterruptPartialTranscript(report) {
  if (!report?.partial) return;

  const { agentId, audioEndMs } = report.partial;
  const now = audioCtx?.currentTime ?? 0;
  const seg = queueSegments.find(
    (s) => s.agentId === agentId && getSegmentState(s, now) !== "done"
  );
  const pending = seg ? segmentTranscripts.get(seg.segmentId) : null;
  if (!pending?.text) return;

  const chunks = playoutSchedule.get(agentId) || [];
  let totalSourceMs = 0;
  for (const c of chunks) totalSourceMs += c.sourceDurationSec * 1000;
  if (totalSourceMs <= 0) return;

  if (interruptTranscriptShownFor === agentId) return;
  interruptTranscriptShownFor = agentId;

  const ratio = Math.min(1, audioEndMs / totalSourceMs);

  if (ratio >= 0.995) {
    _renderTranscriptEntry(pending, pending.addressee);
    return;
  }

  let cutLen = Math.floor(pending.text.length * ratio);
  const lastSpace = pending.text.lastIndexOf(" ", cutLen);
  if (lastSpace > cutLen * 0.5) cutLen = lastSpace;

  const text = pending.text.slice(0, cutLen).trim();
  if (text) {
    _renderTranscriptEntry(
      { ...pending, text: `${text}…` },
      pending.addressee,
      { partial: true }
    );
  }
}

function stopPlayback(newEpoch) {
  for (const source of activeSources) {
    try { source.stop(); } catch (_) { /* already ended */ }
  }
  activeSources.length = 0;
  playoutSchedule.clear();

  cancelAllSegmentSyncTimers();
  queueSegments.length = 0;
  resetTranscriptAudioSync();
  engagementAgentId = null;
  humanTurnPending = false;
  pendingHumanTurnFromServer = false;
  activeHeardSegmentId = null;
  renderQueueSegments();
  syncSidebarFromQueue();

  if (audioCtx) {
    nextPlayTime = audioCtx.currentTime;
  } else {
    nextPlayTime = 0;
  }

  if (newEpoch !== undefined) {
    playoutEpoch = newEpoch;
    playoutBlocked = false;
  } else {
    playoutBlocked = true;
  }

  agentAudioEndTimes.clear();
}

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    nextPlayTime = audioCtx.currentTime;
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

// ─── Microphone capture & PCM16 encoding ─────────────────────────────────────

async function startMicCapture() {
  if (isMicCapturing) return;

  ensureAudioContext();

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: CHANNELS,
        sampleRate: SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (err) {
    updateConnectionStatus("Mic denied", "#ef4444");
    return;
  }

  const source = audioCtx.createMediaStreamSource(micStream);

  // Analyser for waveform visualization
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  // ScriptProcessorNode for PCM16 extraction
  // Buffer size 2048 = ~85ms at 24kHz — enough to keep the event loop happy
  // without excessive latency. (AudioWorklet would be ideal in production.)
  const bufferSize = 2048;
  scriptProcessor = audioCtx.createScriptProcessor(bufferSize, CHANNELS, CHANNELS);

  scriptProcessor.onaudioprocess = (e) => {
    if (!isPTTActive || !ws || ws.readyState !== WebSocket.OPEN) return;

    const float32 = e.inputBuffer.getChannelData(0);

    // Resample if the AudioContext sample rate differs from 24kHz
    const resampled = resampleFloat32(float32, audioCtx.sampleRate, SAMPLE_RATE);

    // Encode to PCM16 little-endian
    const pcm16 = new Int16Array(resampled.length);
    for (let i = 0; i < resampled.length; i++) {
      const clamped = Math.max(-1, Math.min(1, resampled[i]));
      pcm16[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
    }

    ws.send(pcm16.buffer);
  };

  source.connect(scriptProcessor);
  scriptProcessor.connect(audioCtx.destination);

  isMicCapturing = true;
  startWaveformDraw();
}

function stopMicCapture() {
  if (!isMicCapturing) return;

  scriptProcessor?.disconnect();
  scriptProcessor = null;
  analyser?.disconnect();
  analyser = null;

  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;

  isMicCapturing = false;
}

/**
 * Linear interpolation resampler for Float32 audio.
 * Used to normalize browser AudioContext rate (often 44.1kHz or 48kHz) to 24kHz.
 */
function resampleFloat32(input, fromRate, toRate) {
  if (fromRate === toRate) return input;

  const ratio = fromRate / toRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = srcIdx - lo;
    output[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }

  return output;
}

// ─── Human speech recognition ────────────────────────────────────────────────
// Human transcription is handled server-side via a dedicated Realtime session
// (gpt-realtime-whisper, streams as you speak). Final text arrives as TRANSCRIPT
// after END_SPEECH; partial deltas may arrive as HUMAN_TRANSCRIPT_PARTIAL.
// No client-side speech recognition needed.

// ─── Push-To-Talk ─────────────────────────────────────────────────────────────

function handleHumanInvited(agentId, _agentName) {
  engagementAgentId = agentId;
}

function activatePTT() {
  if (isPTTActive || !connectionReady) return;
  isPTTActive = true;
  engagementAgentId = null;
  humanTurnPending = false;
  pendingHumanTurnFromServer = false;
  syncSidebarFromQueue();

  ensureAudioContext();

  // Build playback report BEFORE flushing so server knows what was actually heard
  const playbackReport = buildInterruptReport();
  const hasQueuedAudio = playoutSchedule.size > 0;

  if (hasQueuedAudio) {
    showInterruptPartialTranscript(playbackReport);
  }

  // Local flush + block stale frames until server confirms new epoch
  stopPlayback();

  startMicCapture();

  pttBtn.classList.add("active");
  pttLabel.textContent = "Speaking… (release to end)";

  sendJSON({
    type: "START_SPEECH",
    playbackReport: hasQueuedAudio ? playbackReport : undefined,
  });
}

function deactivatePTT() {
  if (!isPTTActive) return;
  isPTTActive = false;

  pttBtn.classList.remove("active");
  if (!humanTurnPending) pttLabel.textContent = "Hold to Speak";

  sendJSON({ type: "END_SPEECH" });
  humanEndTime = Date.now();
  firstAudioFrameReceived = false;
}

// PTT button
pttBtn.addEventListener("mousedown",  (e) => { e.preventDefault(); activatePTT(); });
pttBtn.addEventListener("mouseup",    () => deactivatePTT());
pttBtn.addEventListener("mouseleave", () => { if (isPTTActive) deactivatePTT(); });
pttBtn.addEventListener("touchstart", (e) => { e.preventDefault(); activatePTT(); }, { passive: false });
pttBtn.addEventListener("touchend",   () => deactivatePTT());

// Spacebar shortcut
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.repeat && document.activeElement === document.body) {
    e.preventDefault();
    activatePTT();
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    deactivatePTT();
  }
});

// ─── Waveform visualizer ──────────────────────────────────────────────────────

let waveformAnimFrame = null;
const waveCtx = waveformCanvas.getContext("2d");

function startWaveformDraw() {
  if (waveformAnimFrame) return;
  drawWaveframe();
}

function drawWaveframe() {
  waveformAnimFrame = requestAnimationFrame(drawWaveframe);

  const w = waveformCanvas.width;
  const h = waveformCanvas.height;

  waveCtx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#0d0f14";
  waveCtx.fillRect(0, 0, w, h);

  if (!analyser || !isPTTActive) {
    // Draw flat idle line
    waveCtx.strokeStyle = "#252a38";
    waveCtx.lineWidth = 1;
    waveCtx.beginPath();
    waveCtx.moveTo(0, h / 2);
    waveCtx.lineTo(w, h / 2);
    waveCtx.stroke();
    return;
  }

  const bufLen = analyser.frequencyBinCount;
  const data = new Uint8Array(bufLen);
  analyser.getByteTimeDomainData(data);

  waveCtx.strokeStyle = "#22c55e";
  waveCtx.lineWidth = 1.5;
  waveCtx.beginPath();

  const sliceW = w / bufLen;
  let x = 0;

  for (let i = 0; i < bufLen; i++) {
    const v = data[i] / 128.0;
    const y = (v * h) / 2;
    if (i === 0) waveCtx.moveTo(x, y);
    else waveCtx.lineTo(x, y);
    x += sliceW;
  }

  waveCtx.lineTo(w, h / 2);
  waveCtx.stroke();
}

// ─── FSM state display ────────────────────────────────────────────────────────

function handleStateChange(prev, next) {
  const badge = stateBadge;
  badge.textContent = next;
  badge.className = "badge";

  const stateClass = {
    "IDLE": "idle",
    "HUMAN_SPEAKING": "human",
    "DECIDING": "deciding",
    "AGENT_SPEAKING": "agent",
  };
  badge.classList.add(stateClass[next] ?? "idle");
}

// ─── Playout queue visualization (one card per continuous speaker) ─────────────

function formatSec(sec) {
  return `${Math.max(0, sec).toFixed(1)} s`;
}

/** Merge into the last segment when the same speaker streams back-to-back. */
function registerQueueSegment(agentId, agentName, sourceDurationSec, effectiveDurationSec, startAt) {
  const endAt = startAt + effectiveDurationSec;
  const last = queueSegments[queueSegments.length - 1];
  const isEngagement = agentId === engagementAgentId;

  if (last && last.agentId === agentId && last.isEngagement === isEngagement) {
    last.chunkCount += 1;
    last.durationSec += sourceDurationSec;
    last.endAt = endAt;
    rescheduleSegmentEndTimer(last);
  } else {
    const seg = {
      segmentId: ++queueSegmentCounter,
      agentId,
      agentName,
      chunkCount: 1,
      durationSec: sourceDurationSec,
      startAt,
      endAt,
      isEngagement,
    };
    queueSegments.push(seg);
    tryBindUnboundTranscript(seg);
    scheduleSegmentUiSync(seg);
  }

  renderQueueSegments();
}

function cancelSegmentTimers(segmentId) {
  const timers = segmentSyncTimers.get(segmentId);
  if (!timers) return;
  if (timers.startId) clearTimeout(timers.startId);
  if (timers.endId) clearTimeout(timers.endId);
  segmentSyncTimers.delete(segmentId);
}

function cancelAllSegmentSyncTimers() {
  for (const segmentId of segmentSyncTimers.keys()) {
    cancelSegmentTimers(segmentId);
  }
}

function scheduleSegmentUiSync(seg) {
  cancelSegmentTimers(seg.segmentId);
  if (!audioCtx) return;

  const now = audioCtx.currentTime;
  const timers = { startId: null, endId: null };

  if (now < seg.startAt) {
    timers.startId = setTimeout(() => onSegmentHeardStart(seg), (seg.startAt - now) * 1000);
  } else if (now < seg.endAt) {
    onSegmentHeardStart(seg);
  }

  timers.endId = setTimeout(() => onSegmentHeardEnd(seg), Math.max(0, (seg.endAt - now) * 1000));
  segmentSyncTimers.set(seg.segmentId, timers);
}

function rescheduleSegmentEndTimer(seg) {
  const timers = segmentSyncTimers.get(seg.segmentId);
  if (!audioCtx) return;

  const now = audioCtx.currentTime;
  if (timers?.endId) clearTimeout(timers.endId);

  if (now < seg.startAt) {
    if (!timers?.startId) {
      const startId = setTimeout(() => onSegmentHeardStart(seg), (seg.startAt - now) * 1000);
      segmentSyncTimers.set(seg.segmentId, { startId, endId: null });
    }
  } else if (now < seg.endAt && activeHeardSegmentId !== seg.segmentId) {
    onSegmentHeardStart(seg);
  }

  const endId = setTimeout(() => onSegmentHeardEnd(seg), Math.max(0, (seg.endAt - now) * 1000));
  const existing = segmentSyncTimers.get(seg.segmentId) ?? { startId: null, endId: null };
  existing.endId = endId;
  segmentSyncTimers.set(seg.segmentId, existing);
}

function onSegmentHeardStart(seg) {
  activeHeardSegmentId = seg.segmentId;
  activateTranscriptForSegment(seg);
  if (seg.isEngagement) {
    pttLabel.textContent = `${seg.agentName} has a question for you…`;
  }
  renderQueueSegments();
  syncSidebarFromQueue();
}

function onSegmentHeardEnd(seg) {
  if (activeHeardSegmentId === seg.segmentId) {
    activeHeardSegmentId = null;
    if (audioCtx) {
      const now = audioCtx.currentTime;
      const next = queueSegments.find((s) => now >= s.startAt && now < s.endAt);
      if (next) onSegmentHeardStart(next);
    }
  }
  if (seg.isEngagement) {
    humanTurnPending = true;
    pendingHumanTurnFromServer = false;
    pttLabel.textContent = "Your turn — hold to speak";
  } else {
    tryActivateHumanTurn();
  }
  renderQueueSegments();
  syncSidebarFromQueue();
}

function hasQueuedAudioAfter(now) {
  return queueSegments.some((s) => s.endAt > now);
}

function tryActivateHumanTurn() {
  if (!pendingHumanTurnFromServer || humanTurnPending) return;
  const now = audioCtx?.currentTime ?? 0;
  // Wait until all buffered agent audio has played — not just when the queue UI is empty.
  if (hasQueuedAudioAfter(now) || activeSources.length > 0) return;
  humanTurnPending = true;
  pendingHumanTurnFromServer = false;
  pttLabel.textContent = "Your turn — hold to speak";
  syncSidebarFromQueue();
}

function inferTranscriptIsEngagement(agentId) {
  const openEngagement = queueSegments.find(
    (s) => s.agentId === agentId && s.isEngagement && !segmentTranscripts.has(s.segmentId)
  );
  if (openEngagement) return true;
  const openMain = queueSegments.find(
    (s) => s.agentId === agentId && !s.isEngagement && !segmentTranscripts.has(s.segmentId)
  );
  if (openMain) return false;
  return false;
}

function findOpenSegmentForTranscript(agentId, isEngagement) {
  for (let i = queueSegments.length - 1; i >= 0; i--) {
    const s = queueSegments[i];
    if (s.agentId === agentId && !!s.isEngagement === isEngagement && !segmentTranscripts.has(s.segmentId)) {
      return s;
    }
  }
  return findAnyOpenSegmentForAgent(agentId);
}

function findAnyOpenSegmentForAgent(agentId) {
  for (let i = queueSegments.length - 1; i >= 0; i--) {
    const s = queueSegments[i];
    if (s.agentId === agentId && !segmentTranscripts.has(s.segmentId)) return s;
  }
  return null;
}

function bindTranscriptToSegment(seg, msg) {
  segmentTranscripts.set(seg.segmentId, msg);
  ensureAgentTranscriptDom(msg, seg);
}

function tryBindAllUnboundTranscripts() {
  for (let i = unboundTranscripts.length - 1; i >= 0; i--) {
    const { msg, isEngagement } = unboundTranscripts[i];
    const seg = findOpenSegmentForTranscript(msg.agentId, isEngagement);
    if (!seg) continue;
    unboundTranscripts.splice(i, 1);
    bindTranscriptToSegment(seg, msg);
  }
}

function tryBindUnboundTranscript(_seg) {
  tryBindAllUnboundTranscripts();
}

function syncPendingTranscriptReveals() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  for (const seg of queueSegments) {
    const entry = transcriptDomBySegment.get(seg.segmentId);
    if (!entry) continue;
    if (now >= seg.startAt) entry.classList.remove("pending-audio");
    else entry.classList.add("pending-audio");
  }
}

function flushUnboundTranscriptsForAgent(_agentId) {
  tryBindAllUnboundTranscripts();
}

function expireOrphanTranscripts() {
  const now = Date.now();
  for (let i = unboundTranscripts.length - 1; i >= 0; i--) {
    const age = now - (unboundTranscripts[i].msg.timestamp || unboundTranscripts[i].receivedAt || 0);
    if (age > 15000) unboundTranscripts.splice(i, 1);
  }
}

function getSegmentState(seg, now) {
  if (seg.endAt <= now) return "done";
  if (seg.startAt <= now) return "playing";
  return "queued";
}

function syncHeardSegmentFromClock() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  for (const seg of queueSegments) {
    if (now >= seg.startAt && now < seg.endAt) {
      if (activeHeardSegmentId !== seg.segmentId) {
        onSegmentHeardStart(seg);
      }
      return;
    }
  }
}

function renderQueueSegments() {
  syncHeardSegmentFromClock();
  tryBindAllUnboundTranscripts();
  syncPendingTranscriptReveals();
  expireOrphanTranscripts();
  const now = audioCtx?.currentTime ?? 0;

  if (queueSegments.length === 0) {
    queueStats.textContent = "0 speakers";
    queueEmpty.style.display = "";
    queueChunksEl.innerHTML = "";
    if (humanTurnPending) {
      queueEmpty.style.display = "none";
      queueChunksEl.innerHTML =
        '<div class="queue-your-turn-banner active">🎙 Your turn — hold to speak</div>';
      queueStats.textContent = "Hold to speak";
    }
    return;
  }

  queueEmpty.style.display = "none";

  const hasFutureAudio = queueSegments.some((seg) => seg.endAt > now);
  const visibleSegments = queueSegments.filter((seg) => {
    const state = getSegmentState(seg, now);
    if (state !== "done") return true;
    if (seg.endAt > now - QUEUE_DONE_VISIBLE_S) return true;
    // Keep the last finished card visible while waiting for the next speaker.
    if (!hasFutureAudio && seg === queueSegments[queueSegments.length - 1]) return true;
    return false;
  });

  let playing = 0;
  let queued = 0;
  for (const seg of visibleSegments) {
    if (seg.segmentId === activeHeardSegmentId) playing += 1;
    else if (getSegmentState(seg, now) !== "done") queued += 1;
  }

  const heardPlaying = visibleSegments.find((s) => s.segmentId === activeHeardSegmentId);
  const drainingSoon =
    (pendingHumanTurnFromServer || humanTurnPending) &&
    heardPlaying &&
    queued === 0 &&
    heardPlaying.endAt - now < 2.0 &&
    heardPlaying.endAt > now;

  queueStats.textContent = drainingSoon
    ? "Your turn next"
    : humanTurnPending && playing === 0 && queued === 0
      ? "Hold to speak"
      : `${visibleSegments.length} turn${visibleSegments.length === 1 ? "" : "s"} · ${playing} playing · ${queued} queued`;

  let html = "";
  if (drainingSoon) {
    html += '<div class="queue-your-turn-banner">🎙 Queue almost empty — your turn next</div>';
  } else if (humanTurnPending && playing === 0 && queued === 0) {
    html += '<div class="queue-your-turn-banner active">🎙 Your turn — hold to speak</div>';
  }

  let nowMarkerPlaced = false;

  for (const seg of visibleSegments) {
    const clockState = getSegmentState(seg, now);
    const isHeardNow = seg.segmentId === activeHeardSegmentId;
    const displayState = isHeardNow ? "playing" : clockState === "done" ? "done" : "queued";

    if (!nowMarkerPlaced && isHeardNow) {
      html += '<div class="queue-now-marker">▶ NOW</div>';
      nowMarkerPlaced = true;
    }

    const agent = agents.find((a) => a.id === seg.agentId);
    const color = agent?.color ?? "#3b82f6";
    const badge = seg.isEngagement && isHeardNow
      ? "ASKS YOU"
      : isHeardNow
        ? "PLAY"
        : displayState === "queued"
          ? "WAIT"
          : "DONE";

    let timingLine = "";
    if (isHeardNow) {
      timingLine = `${formatSec(seg.endAt - now)} left · ${formatSec(seg.durationSec)} buffered`;
    } else if (displayState === "queued") {
      timingLine = `starts in ${formatSec(Math.max(0, seg.startAt - now))} · ${formatSec(seg.durationSec)} buffered`;
    } else {
      timingLine = `${formatSec(seg.durationSec)} played`;
    }

    if (seg.isEngagement && isHeardNow) {
      timingLine = `inviting you · ${seg.chunkCount} chunk${seg.chunkCount === 1 ? "" : "s"} · ${formatSec(seg.durationSec)}`;
    }

    const engagementClass = seg.isEngagement ? " engagement" : "";
    const heardClass = isHeardNow ? " heard-now" : "";

    html += `
      <div class="queue-segment state-${displayState}${engagementClass}${heardClass}" style="--segment-color:${color}" data-segment-id="${seg.segmentId}">
        <div class="queue-segment-bar"></div>
        <div class="queue-segment-info">
          <div class="queue-segment-agent">${escapeHtml(seg.agentName)}${seg.isEngagement ? " → you" : ""}</div>
          <div class="queue-segment-chunks">${seg.chunkCount} chunk${seg.chunkCount === 1 ? "" : "s"} received</div>
          <div class="queue-segment-meta">${timingLine}</div>
        </div>
        <span class="queue-segment-badge">${badge}</span>
      </div>`;
  }

  if (!nowMarkerPlaced && playing === 0 && queued > 0) {
    html = '<div class="queue-now-marker">▶ NOW</div>' + html;
  }

  queueChunksEl.innerHTML = html;
  tryActivateHumanTurn();
  syncSidebarFromQueue();
}

let queueUpdateInterval = null;

function startQueueVisualizer() {
  if (queueUpdateInterval) return;
  renderQueueSegments();
  queueUpdateInterval = setInterval(renderQueueSegments, QUEUE_UPDATE_INTERVAL_MS);
}

// ─── Transcript rendering (audio-segment synced) ──────────────────────────────

/**
 * Agent transcripts are buffered per queue segment and revealed only when
 * that segment's audio actually starts playing (onSegmentHeardStart).
 */
function handleTranscript(msg) {
  if (msg.agentId === "human") {
    _renderTranscriptEntry(msg, msg.addressee);
    return;
  }

  if (msg.partial) {
    if (interruptTranscriptShownFor !== msg.agentId) {
      interruptTranscriptShownFor = msg.agentId;
      _renderTranscriptEntry(msg, msg.addressee, { partial: true });
    }
    return;
  }

  const isEngagement = inferTranscriptIsEngagement(msg.agentId);
  const seg = findOpenSegmentForTranscript(msg.agentId, isEngagement);

  if (seg) {
    bindTranscriptToSegment(seg, msg);
  } else {
    unboundTranscripts.push({ msg, isEngagement, receivedAt: Date.now() });
    if (!msg.timestamp) msg.timestamp = Date.now();
    ensureAgentTranscriptDom(msg, null);
    tryBindAllUnboundTranscripts();
  }
}

function activateTranscriptForSegment(seg) {
  const entry = transcriptDomBySegment.get(seg.segmentId);
  if (entry) entry.classList.remove("pending-audio");
}

function isSegmentPendingAudio(seg) {
  if (!seg || !audioCtx) return true;
  return audioCtx.currentTime < seg.startAt;
}

function ensureAgentTranscriptDom(msg, seg) {
  const segmentId = seg?.segmentId;

  if (segmentId && transcriptDomBySegment.has(segmentId)) {
    updateTranscriptPendingState(segmentId, seg);
    return transcriptDomBySegment.get(segmentId);
  }

  const pendingEntry = pendingTranscriptEntryByAgent.get(msg.agentId);
  if (pendingEntry) {
    if (segmentId) {
      pendingEntry.dataset.segmentId = String(segmentId);
      transcriptDomBySegment.set(segmentId, pendingEntry);
      pendingTranscriptEntryByAgent.delete(msg.agentId);
    }
    updateTranscriptPendingState(segmentId, seg);
    return pendingEntry;
  }

  const entry = buildAgentTranscriptDom(msg, seg);
  insertTranscriptOrdered(entry);
  if (segmentId) {
    transcriptDomBySegment.set(segmentId, entry);
  } else {
    pendingTranscriptEntryByAgent.set(msg.agentId, entry);
  }
  return entry;
}

function updateTranscriptPendingState(segmentId, seg) {
  const entry = segmentId ? transcriptDomBySegment.get(segmentId) : null;
  if (!entry) return;
  if (isSegmentPendingAudio(seg)) entry.classList.add("pending-audio");
  else entry.classList.remove("pending-audio");
}

function buildAgentTranscriptDom(msg, seg) {
  const addressee = seg?.isEngagement ? { kind: "human" } : msg.addressee;
  const pendingAudio = isSegmentPendingAudio(seg);
  const entry = createTranscriptDomElement(msg, addressee, {
    pendingAudio,
    segmentId: seg?.segmentId,
  });
  return entry;
}

function insertTranscriptOrdered(entry) {
  const seq = Number(entry.dataset.seq);
  const children = [...transcriptBody.children];
  const insertBefore = children.find((el) => {
    const elSeq = el.dataset.seq;
    return elSeq && Number(elSeq) > seq;
  });
  if (insertBefore) transcriptBody.insertBefore(entry, insertBefore);
  else transcriptBody.appendChild(entry);
  trimChildren(transcriptBody, MAX_TRANSCRIPT_ENTRIES);
  transcriptBody.scrollTop = transcriptBody.scrollHeight;
}

function formatReplyToLabel(replyTo) {
  if (!replyTo?.name) return "";
  if (replyTo.kind === "human") return ` · replying to ${replyTo.name}`;
  return ` · replying to ${replyTo.name}`;
}

function formatAddresseeLabel(addressee, replyTo) {
  if (!addressee) return "";
  if (addressee.kind === "human") {
    return replyTo?.kind === "human" ? "" : " · asking you";
  }
  if (addressee.kind === "agent" && addressee.name) return ` · to ${addressee.name}`;
  if (addressee.kind === "everyone") return " · to everyone";
  return "";
}

function _buildTranscriptEntryHtml(agentId, agentName, text, timestamp, addressee, replyTo) {
  const agent = agents.find((a) => a.id === agentId);
  const color = agentId === "human" ? "#22c55e" : (agent?.color ?? "#3b82f6");
  const ts = formatTime(timestamp ?? Date.now());
  const replyLabel = formatReplyToLabel(replyTo);
  const addresseeLabel = formatAddresseeLabel(addressee, replyTo);
  return {
    color,
    html: `
      <div class="transcript-header">
        <span class="transcript-speaker">${escapeHtml(agentName)}${replyLabel ? `<span class="transcript-reply-to">${escapeHtml(replyLabel)}</span>` : ""}${addresseeLabel ? `<span class="transcript-addressee">${escapeHtml(addresseeLabel)}</span>` : ""}</span>
        <span class="transcript-time">${ts}</span>
      </div>
      <div class="transcript-text">${escapeHtml(text)}</div>
    `,
  };
}

function createTranscriptDomElement(msg, addressee, options = {}) {
  const empty = transcriptBody.querySelector(".transcript-empty");
  if (empty) empty.remove();

  const { color, html } = _buildTranscriptEntryHtml(
    msg.agentId,
    msg.agentName,
    msg.text,
    msg.timestamp,
    addressee,
    msg.replyTo
  );

  const entry = document.createElement("div");
  entry.className = _transcriptEntryClass(addressee, options);
  if (options.pendingAudio) entry.classList.add("pending-audio");
  entry.dataset.seq = String(++transcriptSeq);
  if (options.segmentId) entry.dataset.segmentId = String(options.segmentId);
  entry.style.setProperty("--entry-color", color);
  entry.innerHTML = html;
  return entry;
}

function _transcriptEntryClass(addressee, options = {}) {
  let entryClass = "transcript-entry";
  if (options.partial) entryClass += " partial-line";
  else if (addressee?.kind === "human") entryClass += " engagement-line";
  else if (addressee?.kind === "agent") entryClass += " directed-line";
  else if (addressee?.kind === "everyone") entryClass += " everyone-line";
  return entryClass;
}

/** Immediate transcript line (human speech or interrupt partial). */
function _renderTranscriptEntry(msg, addressee, options = {}) {
  const resolvedAddressee = addressee ?? msg.addressee;
  const entry = createTranscriptDomElement(
    { ...msg, replyTo: msg.replyTo },
    resolvedAddressee,
    options
  );
  insertTranscriptOrdered(entry);
}

/** System routing line in the transcript pane (Groq / selection). */
function _renderSystemTranscriptLine(speaker, detail) {
  const empty = transcriptBody.querySelector(".transcript-empty");
  if (empty) empty.remove();

  const entry = document.createElement("div");
  entry.className = "transcript-entry system-line";
  entry.dataset.seq = String(++transcriptSeq);
  entry.style.setProperty("--entry-color", "#f59e0b");
  entry.innerHTML = `
    <div class="transcript-header">
      <span class="transcript-speaker">${escapeHtml(speaker)}</span>
      <span class="transcript-time">${formatTime(Date.now())}</span>
    </div>
    <div class="transcript-text">${escapeHtml(detail)}</div>
  `;

  insertTranscriptOrdered(entry);
}

/** Drop audio-sync bookkeeping on interrupt; transcript history stays in the pane. */
function resetTranscriptAudioSync() {
  segmentTranscripts.clear();
  transcriptDomBySegment.clear();
  pendingTranscriptEntryByAgent.clear();
  unboundTranscripts.length = 0;
  for (const entry of transcriptBody.querySelectorAll(".transcript-entry.pending-audio")) {
    entry.classList.remove("pending-audio");
  }
}

// ─── Overlay ──────────────────────────────────────────────────────────────────

function showOverlay(title, sub) {
  overlay.classList.remove("hidden");
  overlay.querySelector(".overlay-title").textContent = title;
  overlaySub.textContent = sub;
}

function hideOverlay() {
  overlay.classList.add("hidden");
}

function updateConnectionStatus(text, color) {
  connectionStatus.textContent = text;
  connectionStatus.style.color = color;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatTime(ts) {
  const d = new Date(ts);
  return (
    String(d.getHours()).padStart(2, "0") + ":" +
    String(d.getMinutes()).padStart(2, "0") + ":" +
    String(d.getSeconds()).padStart(2, "0")
  );
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Remove oldest children if count exceeds max. */
function trimChildren(el, max) {
  while (el.children.length > max) {
    el.removeChild(el.firstChild);
  }
}

// ─── Playback speed control ───────────────────────────────────────────────────

function updateSpeedButton() {
  const label = playbackSpeed === 1 ? "1×" : `${playbackSpeed}×`;
  speedBtn.textContent = label;
  speedBtn.classList.toggle("active-speed", playbackSpeed !== 1);
  speedBtn.title = `Playback speed: ${label} (click to cycle)`;
}

function cyclePlaybackSpeed() {
  playbackSpeedIndex = (playbackSpeedIndex + 1) % PLAYBACK_SPEEDS.length;
  playbackSpeed = PLAYBACK_SPEEDS[playbackSpeedIndex];
  updateSpeedButton();
}

speedBtn.addEventListener("click", cyclePlaybackSpeed);
updateSpeedButton();

document.getElementById("transcript-clear-btn")?.addEventListener("click", () => {
  transcriptBody.innerHTML = '<div class="transcript-empty">Transcript cleared.</div>';
  segmentTranscripts.clear();
  transcriptDomBySegment.clear();
  pendingTranscriptEntryByAgent.clear();
  unboundTranscripts.length = 0;
  transcriptSeq = 0;
});

// ─── Init ─────────────────────────────────────────────────────────────────────

connectWebSocket();
drawWaveframe();
startQueueVisualizer();
