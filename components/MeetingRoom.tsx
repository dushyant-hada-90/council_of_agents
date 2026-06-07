"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { PlayoutTranscriptEngine, type TranscriptDisplayLine } from "@/lib/meeting/playoutTranscript";
import {
  deriveDisplayStatus,
  getHeardAgentAt,
  hasQueuedAudioAfter,
} from "@/lib/meeting/playoutClock";

import {
  CAPTURE_SAMPLE_RATE,
  downsampleFloat32,
  float32ToPcm16,
} from "@/lib/meeting/audioCapture";

const SAMPLE_RATE = CAPTURE_SAMPLE_RATE;
const PLAYBACK_BUFFER_AHEAD_S = 0.05;

interface AgentMeta {
  id: string;
  name: string;
  voice: string;
  color: string;
}

interface PlayoutChunk {
  startAt: number;
  sourceDurationSec: number;
  effectiveDurationSec: number;
  source: AudioBufferSourceNode;
  isEngagement?: boolean;
}

interface InterruptPlaybackReport {
  fullyHeard: string[];
  partial: { agentId: string; audioEndMs: number } | null;
  unheard: string[];
}

interface MeetingRoomProps {
  meetingId: string;
  humanName: string;
  initialAgents?: AgentMeta[];
  isGuest?: boolean;
  guestToken?: string;
  refinedPrompt?: string;
  audioLimits?: { audioWarnSeconds: number; audioMaxSeconds: number };
}

export function MeetingRoom({
  meetingId,
  humanName,
  initialAgents = [],
  isGuest = false,
  guestToken,
  refinedPrompt,
  audioLimits,
}: MeetingRoomProps) {
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [agents, setAgents] = useState<AgentMeta[]>(initialAgents);
  const [displayStatus, setDisplayStatus] = useState("Idle");
  const [displayLines, setDisplayLines] = useState<TranscriptDisplayLine[]>([]);
  const [speakingAgentId, setSpeakingAgentId] = useState<string | null>(null);
  const [isPTTActive, setIsPTTActive] = useState(false);
  const [humanTurnReady, setHumanTurnReady] = useState(false);
  const [engagementHint, setEngagementHint] = useState<string | null>(null);
  const [meetingEnded, setMeetingEnded] = useState(false);
  const [audioLimitWarning, setAudioLimitWarning] = useState<number | null>(null);
  const [audioLimitEnded, setAudioLimitEnded] = useState(false);
  const [endReason, setEndReason] = useState<string | null>(null);
  const transcriptEngineRef = useRef(new PlayoutTranscriptEngine());
  const lastHeardAgentRef = useRef<string | null>(null);
  const lastDisplayStatusRef = useRef("Idle");
  const pendingHumanTurnRef = useRef(false);
  const humanTurnReadyRef = useRef(false);
  const lastEngagementHintRef = useRef<string | null>(null);
  const engagementAgentIdRef = useRef<string | null>(null);
  const engagementPendingRef = useRef<string | null>(null);
  const endInFlightRef = useRef(false);
  const hasNavigatedRef = useRef(false);
  const endFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearEndFallbackTimer() {
    if (endFallbackTimerRef.current) {
      clearTimeout(endFallbackTimerRef.current);
      endFallbackTimerRef.current = null;
    }
  }

  /** Navigate away after meeting is fully ended on the server. */
  function finalizeEnd(reason?: string) {
    if (hasNavigatedRef.current) return;
    hasNavigatedRef.current = true;
    clearEndFallbackTimer();
    endInFlightRef.current = false;
    setMeetingEnded(true);
    setEnding(false);
    setConnected(false);
    connectedRef.current = false;
    wsRef.current?.close();

    if (reason === "audio_limit" && isGuest) {
      setAudioLimitEnded(true);
      setEndReason("audio_limit");
      return;
    }

    router.push(
      isGuest && guestToken
        ? `/meetings/${meetingId}/transcript?guest=${encodeURIComponent(guestToken)}`
        : `/meetings/${meetingId}/transcript`
    );
  }

  async function endMeeting() {
    if (endInFlightRef.current || hasNavigatedRef.current || meetingEnded) return;
    endInFlightRef.current = true;
    setEnding(true);

    const fallbackEnd = () => {
      void (async () => {
        try {
          if (!isGuest) {
            await fetch(`/api/meetings/${meetingId}/end`, { method: "POST" });
          }
        } catch {
          setError("Failed to end meeting — try again");
          endInFlightRef.current = false;
          setEnding(false);
          hasNavigatedRef.current = false;
          return;
        }
        finalizeEnd();
      })();
    };

    try {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "END_MEETING" }));
        endFallbackTimerRef.current = setTimeout(fallbackEnd, 8000);
        return;
      }
      if (!isGuest) {
        await fetch(`/api/meetings/${meetingId}/end`, { method: "POST" });
      }
      finalizeEnd();
    } catch {
      clearEndFallbackTimer();
      setError("Failed to end meeting");
      endInFlightRef.current = false;
      setEnding(false);
    }
  }

  function getAgentMeta(agentId: string): AgentMeta | undefined {
    return agentsRef.current.find((a) => a.id === agentId);
  }

  /** True only for the engagement-question speech act (not the agent's main turn). */
  function isEngagementTurn(agentId: string): boolean {
    return engagementAgentIdRef.current === agentId;
  }

  function resolveEngagementForAudio(agentId: string): boolean {
    if (engagementPendingRef.current === agentId) {
      engagementAgentIdRef.current = agentId;
      engagementPendingRef.current = null;
      return true;
    }
    return engagementAgentIdRef.current === agentId;
  }

  function agentColor(agentId: string): string | undefined {
    if (agentId === "human") return "#60a5fa";
    return getAgentMeta(agentId)?.color;
  }

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const captureSampleRateRef = useRef(SAMPLE_RATE);
  const nextPlayTimeRef = useRef(0);
  const playoutEpochRef = useRef(0);
  const playoutBlockedRef = useRef(false);
  const isPTTActiveRef = useRef(false);
  const connectedRef = useRef(false);
  const agentsRef = useRef<AgentMeta[]>(initialAgents);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playoutScheduleRef = useRef<Map<string, PlayoutChunk[]>>(new Map());

  function syncPlayoutUi(now: number): void {
    const engine = transcriptEngineRef.current;
    const transcriptChanged = engine.tick(now);
    if (transcriptChanged) setDisplayLines(engine.getDisplayLines());

    const heard = getHeardAgentAt(now, playoutScheduleRef.current);
    const queueBusy = hasQueuedAudioAfter(
      now,
      playoutScheduleRef.current,
      nextPlayTimeRef.current,
      activeSourcesRef.current.length
    );

    const turnReady =
      pendingHumanTurnRef.current && !queueBusy && !isPTTActiveRef.current;
    if (turnReady !== humanTurnReadyRef.current) {
      humanTurnReadyRef.current = turnReady;
      setHumanTurnReady(turnReady);
    }

    if (heard !== lastHeardAgentRef.current) {
      lastHeardAgentRef.current = heard;
      setSpeakingAgentId(heard);
    }

    let engagementLabel: string | null = null;
    if (heard) {
      const chunks = playoutScheduleRef.current.get(heard);
      const activeChunk = chunks?.find(
        (c) => now >= c.startAt && now < c.startAt + c.effectiveDurationSec
      );
      if (activeChunk?.isEngagement) {
        engagementLabel = getAgentMeta(heard)?.name ?? null;
      }
    }
    if (engagementLabel !== lastEngagementHintRef.current) {
      lastEngagementHintRef.current = engagementLabel;
      setEngagementHint(engagementLabel);
    }

    const status = deriveDisplayStatus({
      isPTTActive: isPTTActiveRef.current,
      humanName,
      heardAgentName: heard ? (getAgentMeta(heard)?.name ?? null) : null,
      humanTurnReady: turnReady,
      queueBusy,
    });
    if (status !== lastDisplayStatusRef.current) {
      lastDisplayStatusRef.current = status;
      setDisplayStatus(status);
    }
  }

  function stopPlayback(newEpoch?: number) {
    const ctx = audioCtxRef.current;
    if (ctx) transcriptEngineRef.current.flushAtTime(ctx.currentTime);

    for (const source of activeSourcesRef.current) {
      try {
        source.stop();
      } catch {
        /* already ended */
      }
    }
    activeSourcesRef.current = [];
    playoutScheduleRef.current.clear();
    lastHeardAgentRef.current = null;
    pendingHumanTurnRef.current = false;
    engagementAgentIdRef.current = null;
    engagementPendingRef.current = null;
    setSpeakingAgentId(null);
    setHumanTurnReady(false);
    setEngagementHint(null);
    humanTurnReadyRef.current = false;
    lastEngagementHintRef.current = null;
    lastDisplayStatusRef.current = "Idle";
    setDisplayStatus(isPTTActiveRef.current ? `${humanName} is speaking` : "Idle");
    setDisplayLines(transcriptEngineRef.current.getDisplayLines());

    nextPlayTimeRef.current = ctx ? ctx.currentTime : 0;

    if (newEpoch !== undefined) {
      playoutEpochRef.current = newEpoch;
      playoutBlockedRef.current = false;
    } else {
      playoutBlockedRef.current = true;
    }
  }

  function buildInterruptReport(): InterruptPlaybackReport {
    const ctx = audioCtxRef.current;
    if (!ctx) {
      return { fullyHeard: [], partial: null, unheard: [] };
    }

    const now = ctx.currentTime;
    const fullyHeard: string[] = [];
    const unheard: string[] = [];
    let partial: InterruptPlaybackReport["partial"] = null;

    for (const [agentId, chunks] of playoutScheduleRef.current) {
      if (!chunks.length) continue;

      const firstStart = chunks[0]!.startAt;
      const lastChunk = chunks[chunks.length - 1]!;
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
            playedMs += (now - c.startAt) * 1000;
          }
        }
        partial = { agentId, audioEndMs: Math.floor(playedMs) };
      }
    }

    return { fullyHeard, partial, unheard };
  }

  const connect = useCallback(async () => {
    let accessToken: string;

    if (isGuest && guestToken) {
      accessToken = guestToken;
    } else {
      const sessionRes = await fetch("/api/auth/session");
      if (!sessionRes.ok) {
        setError("Not authenticated");
        setConnecting(false);
        return;
      }
      const session = await sessionRes.json();
      accessToken = session.accessToken;
    }

    try {
      const historyUrl = isGuest
        ? `/api/guest/transcripts/${meetingId}?token=${encodeURIComponent(accessToken)}`
        : `/api/transcripts/${meetingId}`;
      const historyRes = await fetch(historyUrl);
      if (historyRes.ok) {
        const history = (await historyRes.json()) as {
          meeting?: { status?: string };
          messages?: Array<{
            speaker_id: string;
            speaker_name: string;
            speaker_type: "human" | "agent";
            message: string;
            message_timestamp: string;
          }>;
        };

        if (history.meeting?.status === "ended") {
          setMeetingEnded(true);
        }

        const historical = (history.messages ?? []).map((m) => ({
          speakerId: m.speaker_id,
          speakerName: m.speaker_name,
          speakerType: m.speaker_type,
          message: m.message,
          timestamp: new Date(m.message_timestamp).getTime(),
        }));

        if (historical.length > 0) {
          transcriptEngineRef.current.loadHistory(historical);
          setDisplayLines(transcriptEngineRef.current.getDisplayLines());
        }

        if (history.meeting?.status === "ended") {
          setConnecting(false);
          return;
        }
      }
    } catch {
      /* continue to live connect */
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws?meetingId=${meetingId}&token=${accessToken}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      connectedRef.current = true;
      setConnected(true);
      setConnecting(false);
      setError(null);
    };

    ws.onclose = (ev) => {
      if (wsRef.current !== ws) return;
      connectedRef.current = false;
      setConnected(false);
      setConnecting(false);
      if (endInFlightRef.current || hasNavigatedRef.current) {
        if (ev.code === 1000) finalizeEnd(endReason ?? undefined);
        return;
      }
      if (ev.code === 4004 || ev.reason?.includes("ended")) {
        setMeetingEnded(true);
        return;
      }
      if (ev.code !== 1000) {
        setError("Connection lost — refresh to rejoin the meeting");
      }
    };

    ws.onerror = () => {
      if (wsRef.current !== ws) return;
      setError("WebSocket connection failed");
      setConnecting(false);
    };

    ws.onmessage = (ev) => {
      if (wsRef.current !== ws) return;
      if (ev.data instanceof ArrayBuffer) {
        handleAudioFrame(ev.data);
        return;
      }
      try {
        const msg = JSON.parse(ev.data as string);
        handleControlMessage(msg);
      } catch { /* ignore */ }
    };
  }, [meetingId, isGuest, guestToken]);

  function handleControlMessage(msg: Record<string, unknown>) {
    switch (msg.type) {
      case "ROOM_READY": {
        const roster = (msg.agents as AgentMeta[]) ?? [];
        agentsRef.current = roster;
        setAgents(roster);
        break;
      }
      case "STATE_CHANGE":
        break;
      case "AGENT_SPEAKING_START":
        break;
      case "AGENT_SPEAKING_END":
        break;
      case "TRANSCRIPT_DELTA": {
        const agentId = msg.agentId as string;
        transcriptEngineRef.current.appendDelta(
          agentId,
          msg.agentName as string,
          msg.delta as string,
          isEngagementTurn(agentId)
        );
        break;
      }
      case "TRANSCRIPT": {
        const agentId = msg.agentId as string;
        const agentName = msg.agentName as string;
        const text = msg.text as string;
        const partial = msg.partial as boolean | undefined;
        if (agentId === "human") {
          transcriptEngineRef.current.addHumanLine(agentId, agentName, text, agentColor("human"));
          setDisplayLines(transcriptEngineRef.current.getDisplayLines());
        } else {
          const isEngagement = isEngagementTurn(agentId);
          transcriptEngineRef.current.finalizeAgentTranscript(agentId, agentName, text, partial, {
            isEngagement,
            color: agentColor(agentId),
          });
          if (isEngagement && !partial) engagementAgentIdRef.current = null;
          // Agent lines appear on the audio clock via syncPlayoutUi/tick — not on server TRANSCRIPT.
          if (partial) {
            setDisplayLines(transcriptEngineRef.current.getDisplayLines());
          }
        }
        break;
      }
      case "HUMAN_TURN_READY":
        pendingHumanTurnRef.current = true;
        break;
      case "HUMAN_INVITED": {
        const agentId = msg.agentId as string;
        pendingHumanTurnRef.current = false;
        humanTurnReadyRef.current = false;
        setHumanTurnReady(false);
        engagementPendingRef.current = agentId;
        transcriptEngineRef.current.closeAgentTurn(agentId);
        break;
      }
      case "STOP_CLIENT_AUDIO":
        stopPlayback(msg.epoch as number);
        break;
      case "AUDIO_LIMIT_WARNING":
        setAudioLimitWarning(msg.remainingSeconds as number);
        break;
      case "MEETING_ENDED":
        finalizeEnd(msg.reason as string | undefined);
        break;
    }
  }

  function handleAudioFrame(data: ArrayBuffer) {
    if (data.byteLength <= 3) return;

    const view = new DataView(data);
    const agentIndex = view.getUint8(0);
    const epoch = view.getUint16(1, true);
    if (playoutBlockedRef.current || epoch !== playoutEpochRef.current) return;

    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();

    const agentId = agentsRef.current[agentIndex]?.id ?? null;
    const agentName = agentsRef.current[agentIndex]?.name ?? agentId ?? "Agent";

    // Header is 3 bytes; PCM16 starts at offset 3 (not 2-byte aligned for Int16Array)
    const sampleCount = Math.floor((data.byteLength - 3) / 2);
    if (sampleCount === 0) return;

    const float32 = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      float32[i] = view.getInt16(3 + i * 2, true) / 32768;
    }

    const buffer = ctx.createBuffer(1, float32.length, SAMPLE_RATE);
    buffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const sourceDurationSec = buffer.duration;
    const now = ctx.currentTime;
    const start = Math.max(now + PLAYBACK_BUFFER_AHEAD_S, nextPlayTimeRef.current || now + PLAYBACK_BUFFER_AHEAD_S);

    try {
      source.start(start);
    } catch {
      return;
    }

    activeSourcesRef.current.push(source);
    source.onended = () => {
      const idx = activeSourcesRef.current.indexOf(source);
      if (idx >= 0) activeSourcesRef.current.splice(idx, 1);
    };

    nextPlayTimeRef.current = start + sourceDurationSec;

    if (agentId) {
      const isEngagement = resolveEngagementForAudio(agentId);
      transcriptEngineRef.current.registerAudio(agentId, agentName, start, sourceDurationSec, {
        isEngagement,
        color: agentColor(agentId),
      });

      if (!playoutScheduleRef.current.has(agentId)) {
        playoutScheduleRef.current.set(agentId, []);
      }
      playoutScheduleRef.current.get(agentId)!.push({
        startAt: start,
        sourceDurationSec,
        effectiveDurationSec: sourceDurationSec,
        source,
        isEngagement,
      });
    }
  }

  async function initAudio() {
    audioCtxRef.current = new AudioContext({ sampleRate: SAMPLE_RATE });
    captureSampleRateRef.current = audioCtxRef.current.sampleRate;
    if (captureSampleRateRef.current !== SAMPLE_RATE) {
      console.warn(
        `[MeetingRoom] AudioContext sampleRate=${captureSampleRateRef.current}Hz (requested ${SAMPLE_RATE}Hz) — resampling mic to ${SAMPLE_RATE}Hz before STT`
      );
    }
    // Request mono audio with noise/echo processing to improve STT accuracy
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: { ideal: SAMPLE_RATE },
      },
    });
    micStreamRef.current = stream;
    const source = audioCtxRef.current.createMediaStreamSource(stream);
    // bufferSize=4096, inputChannels=1, outputChannels=1 — always mono
    const processor = audioCtxRef.current.createScriptProcessor(4096, 1, 1);
    scriptProcessorRef.current = processor;

    processor.onaudioprocess = (e) => {
      if (!isPTTActiveRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const input = e.inputBuffer.getChannelData(0);
      const captureRate = captureSampleRateRef.current;
      const samples =
        captureRate === SAMPLE_RATE
          ? input
          : downsampleFloat32(input, captureRate, SAMPLE_RATE);
      const pcm16 = float32ToPcm16(samples);
      wsRef.current.send(pcm16.buffer);
    };

    source.connect(processor);
    processor.connect(audioCtxRef.current.destination);
  }

  function startPTT() {
    if (!connectedRef.current) return;

    const playbackReport = buildInterruptReport();
    const hasQueuedAudio = playoutScheduleRef.current.size > 0;

    // Flush local playout immediately; block stale frames until server confirms epoch
    stopPlayback();

    isPTTActiveRef.current = true;
    setIsPTTActive(true);
    pendingHumanTurnRef.current = false;
    humanTurnReadyRef.current = false;
    setHumanTurnReady(false);

    wsRef.current?.send(
      JSON.stringify({
        type: "START_SPEECH",
        playbackReport: hasQueuedAudio ? playbackReport : undefined,
      })
    );
  }

  function endPTT() {
    if (!isPTTActiveRef.current) return;
    isPTTActiveRef.current = false;
    setIsPTTActive(false);
    wsRef.current?.send(
      JSON.stringify({
        type: "END_SPEECH",
        captureSampleRate: captureSampleRateRef.current,
      })
    );
  }

  useEffect(() => {
    void connect();
    void initAudio().catch(() => setError("Microphone access denied"));

    let rafId = 0;
    const loop = () => {
      const ctx = audioCtxRef.current;
      if (ctx) syncPlayoutUi(ctx.currentTime);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    function onKeyDown(e: KeyboardEvent) {
      if (e.code === "Space" && !e.repeat) { e.preventDefault(); startPTT(); }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") { e.preventDefault(); endPTT(); }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    return () => {
      clearEndFallbackTimer();
      cancelAnimationFrame(rafId);
      const ws = wsRef.current;
      wsRef.current = null;
      connectedRef.current = false;
      if (ws) {
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
      }
      scriptProcessorRef.current?.disconnect();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      audioCtxRef.current?.close();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [connect]);

  return (
    <div className="space-y-4">
      {refinedPrompt && isGuest && (
        <p className="text-sm text-gray-400 border-l-2 border-accent pl-3">{refinedPrompt}</p>
      )}

      {audioLimitWarning !== null && !audioLimitEnded && (
        <div className="bg-yellow-900/40 border border-yellow-700 text-yellow-200 px-4 py-3 rounded-lg text-sm">
          About {Math.ceil(audioLimitWarning / 60)} minute{audioLimitWarning >= 120 ? "s" : ""} of free audio remaining.
          {" "}
          <a href="/signup" className="underline hover:text-white">Sign up</a> for unlimited meetings.
        </div>
      )}

      {audioLimitEnded && (
        <div className="bg-surface-border border border-gray-600 rounded-lg p-6 text-center space-y-4">
          <h2 className="text-xl font-semibold">Free session complete</h2>
          <p className="text-gray-400">
            You&apos;ve used your {audioLimits ? Math.round(audioLimits.audioMaxSeconds / 60) : 10} minutes of free guest audio.
            Sign up to continue exploring with unlimited meeting time and saved history.
          </p>
          <div className="flex gap-3 justify-center">
            <a href="/signup" className="btn-primary px-6 py-2">Sign up free</a>
            <a href="/login" className="text-gray-300 hover:text-white px-6 py-2">Log in</a>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Live Meeting</h1>
          <p className="text-gray-400 text-sm">{displayStatus}</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void endMeeting()}
            disabled={!connected || ending || meetingEnded}
            className="text-sm px-3 py-1.5 rounded-lg bg-red-900/80 text-red-200 hover:bg-red-800 disabled:opacity-50"
          >
            {meetingEnded ? "Ended" : ending ? "Ending…" : "End meeting"}
          </button>
          <span className={`text-sm px-3 py-1 rounded-full ${connected ? "bg-green-900 text-green-300" : "bg-red-900 text-red-300"}`}>
            {connecting ? "Connecting…" : connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </div>

      {error && <p className="text-red-400">{error}</p>}

      {meetingEnded && !connected && (
        <p className="text-yellow-400 text-sm">
          This meeting has ended. Transcript below is from the database.
        </p>
      )}

      {!meetingEnded && !audioLimitEnded && (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card text-center border-blue-500/50">
          <p className="font-medium">{humanName}</p>
          <p className="text-xs text-gray-400">You</p>
          {isPTTActive && <p className="text-green-400 text-xs mt-1">Speaking</p>}
          {humanTurnReady && !isPTTActive && (
            <p className="text-yellow-400 text-xs mt-1">Your turn — hold to speak</p>
          )}
          {engagementHint && !isPTTActive && !humanTurnReady && (
            <p className="text-yellow-400 text-xs mt-1">{engagementHint} has a question…</p>
          )}
        </div>
        {agents.map((a) => (
          <div
            key={a.id}
            className="card text-center"
            style={{ borderColor: speakingAgentId === a.id ? a.color : undefined }}
          >
            <p className="font-medium" style={{ color: a.color }}>{a.name}</p>
            <p className="text-xs text-gray-400">{a.voice}</p>
            {speakingAgentId === a.id && <p className="text-xs mt-1" style={{ color: a.color }}>Speaking</p>}
          </div>
        ))}
      </div>
      )}

      {!meetingEnded && !audioLimitEnded && (
      <div className="flex justify-center">
        <button
          onMouseDown={startPTT}
          onMouseUp={endPTT}
          onMouseLeave={endPTT}
          onTouchStart={(e) => { e.preventDefault(); startPTT(); }}
          onTouchEnd={(e) => { e.preventDefault(); endPTT(); }}
          disabled={!connected}
          className={`px-12 py-6 rounded-full text-lg font-bold select-none ${
            isPTTActive ? "bg-red-600 scale-105" : humanTurnReady ? "bg-yellow-600 hover:bg-yellow-500" : "bg-accent hover:bg-blue-600"
          } disabled:opacity-50`}
        >
          {isPTTActive
            ? "Release to send"
            : humanTurnReady
              ? "Your turn — hold to speak (Space)"
              : "Hold to speak (Space)"}
        </button>
      </div>
      )}

      <div className="card max-h-80 overflow-y-auto">
        <h2 className="font-semibold mb-3">Live Transcript</h2>
        {displayLines.length === 0 ? (
          <p className="text-gray-500 text-sm">Transcript will appear here as agents speak…</p>
        ) : (
          <div className="space-y-2">
            {displayLines.map((t) => {
              const nameColor =
                t.color ??
                agentColor(t.agentId) ??
                (agents.find((a) => a.id === t.agentId)?.color ?? "#e5e7eb");
              return (
              <div key={t.id} className="text-sm">
                <span className="font-medium" style={{ color: nameColor }}>
                  {t.agentName}{t.isEngagement ? " → you" : ""}:
                </span>{" "}
                {t.pending && !t.visibleText ? (
                  <span className="text-gray-600 italic">…</span>
                ) : (
                  <span className={t.partial ? "text-gray-500 italic" : t.live ? "text-gray-200" : "text-gray-300"}>
                    {t.visibleText}
                    {t.live && <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-gray-400 animate-pulse align-middle" />}
                  </span>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
