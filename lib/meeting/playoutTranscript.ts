/**
 * Buffers agent transcripts and reveals text word-by-word in sync with
 * scheduled Web Audio playout — not when the Realtime API finishes.
 */

export interface TranscriptDisplayLine {
  id: string;
  agentId: string;
  agentName: string;
  color?: string;
  visibleText: string;
  fullText: string;
  pending: boolean;
  partial?: boolean;
  live?: boolean;
  isEngagement?: boolean;
  /** Monotonic key — lines sorted by this for spoken order. */
  displayOrder: number;
}

interface PlayoutSegment {
  segmentId: number;
  agentId: string;
  agentName: string;
  startAt: number;
  endAt: number;
  durationSec: number;
  draftText: string;
  finalText: string | null;
  partial: boolean;
  closed: boolean;
  isEngagement: boolean;
  displayOrder: number;
}

function splitWords(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

/** Map audio progress [0,1] to a prefix of words. */
export function revealTextByProgress(fullText: string, progress: number): string {
  const trimmed = fullText.trim();
  if (!trimmed) return "";
  if (progress >= 0.995) return trimmed;
  if (progress <= 0) return "";

  const words = splitWords(trimmed);
  if (words.length === 0) return "";
  const count = Math.min(words.length, Math.max(1, Math.ceil(progress * words.length)));
  return words.slice(0, count).join("").trimEnd();
}

export class PlayoutTranscriptEngine {
  private segments: PlayoutSegment[] = [];
  private segmentCounter = 0;
  private lines = new Map<number, TranscriptDisplayLine>();
  private humanLines: TranscriptDisplayLine[] = [];
  private lastVisibleBySegment = new Map<number, string>();
  private nextDisplayOrder = 0;
  /** Text that arrived before the matching audio segment was scheduled. */
  private unboundText = new Map<string, { agentName: string; text: string; color?: string }>();

  registerAudio(
    agentId: string,
    agentName: string,
    startAt: number,
    sourceDurationSec: number,
    options?: { isEngagement?: boolean; color?: string }
  ): number {
    const isEngagement = options?.isEngagement ?? false;
    const color = options?.color;
    const endAt = startAt + sourceDurationSec;
    const last = this.segments[this.segments.length - 1];

    // Merge only consecutive audio chunks from the same turn (not a new speech act).
    if (
      last &&
      last.agentId === agentId &&
      last.isEngagement === isEngagement &&
      !last.partial &&
      !last.closed
    ) {
      last.durationSec += sourceDurationSec;
      last.endAt = endAt;
      return last.segmentId;
    }

    const segmentId = ++this.segmentCounter;
    const displayOrder = ++this.nextDisplayOrder;
    const unboundKey = this.unboundKey(agentId, isEngagement);

    const seg: PlayoutSegment = {
      segmentId,
      agentId,
      agentName,
      startAt,
      endAt,
      durationSec: sourceDurationSec,
      draftText: "",
      finalText: null,
      partial: false,
      closed: false,
      isEngagement,
      displayOrder,
    };

    const unbound = this.unboundText.get(unboundKey);
    if (unbound) {
      seg.finalText = unbound.text;
      seg.draftText = unbound.text;
      seg.agentName = unbound.agentName;
      this.unboundText.delete(unboundKey);
    }

    this.segments.push(seg);

    this.lines.set(segmentId, {
      id: `seg-${segmentId}`,
      agentId,
      agentName: seg.agentName,
      color,
      visibleText: "",
      fullText: seg.finalText ?? "",
      pending: true,
      live: false,
      isEngagement,
      displayOrder,
    });

    return segmentId;
  }

  /** Force the next audio from this agent into a new segment (e.g. engagement question). */
  closeAgentTurn(agentId: string): void {
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const seg = this.segments[i]!;
      if (seg.agentId === agentId && !seg.closed) {
        seg.closed = true;
        const line = this.lines.get(seg.segmentId);
        if (line && seg.finalText) {
          line.fullText = seg.finalText;
        }
        break;
      }
    }
  }

  appendDelta(
    agentId: string,
    agentName: string,
    delta: string,
    isEngagement = false
  ): void {
    if (!delta) return;
    const seg = this.findOpenSegment(agentId, isEngagement);
    if (!seg) return;
    seg.draftText += delta;
    const line = this.lines.get(seg.segmentId);
    if (line) {
      line.fullText = seg.finalText ?? seg.draftText;
      line.agentName = agentName;
    }
  }

  finalizeAgentTranscript(
    agentId: string,
    agentName: string,
    text: string,
    partial = false,
    options?: { isEngagement?: boolean; color?: string }
  ): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const isEngagement = options?.isEngagement ?? false;

    if (partial) {
      const seg =
        this.findOpenSegment(agentId, isEngagement) ??
        this.findLatestSegment(agentId, isEngagement);
      if (seg) {
        seg.finalText = trimmed;
        seg.draftText = trimmed;
        seg.partial = true;
        seg.closed = true;
        const line = this.lines.get(seg.segmentId);
        if (line) {
          line.fullText = trimmed;
          line.visibleText = trimmed;
          line.pending = false;
          line.partial = true;
          line.live = false;
          this.lastVisibleBySegment.set(seg.segmentId, trimmed);
        }
      } else {
        this.humanLines.push({
          id: `partial-${Date.now()}`,
          agentId,
          agentName,
          color: options?.color,
          visibleText: trimmed,
          fullText: trimmed,
          pending: false,
          partial: true,
          displayOrder: ++this.nextDisplayOrder,
        });
      }
      return;
    }

    const seg =
      this.findOpenSegment(agentId, isEngagement) ??
      this.findLatestSegment(agentId, isEngagement);
    if (seg && !seg.partial) {
      seg.finalText = trimmed;
      seg.draftText = trimmed;
      seg.closed = true;
      const line = this.lines.get(seg.segmentId);
      if (line) {
        line.fullText = trimmed;
        line.agentName = agentName;
        if (options?.color) line.color = options.color;
      }
      return;
    }

    this.unboundText.set(this.unboundKey(agentId, isEngagement), {
      agentName,
      text: trimmed,
      color: options?.color,
    });
  }

  addHumanLine(
    agentId: string,
    agentName: string,
    text: string,
    color = "#60a5fa"
  ): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.humanLines.push({
      id: `human-${Date.now()}-${Math.random()}`,
      agentId,
      agentName,
      color,
      visibleText: trimmed,
      fullText: trimmed,
      pending: false,
      displayOrder: ++this.nextDisplayOrder,
    });
  }

  /** Hydrate UI from persisted transcript rows (e.g. after page refresh). */
  loadHistory(
    entries: Array<{
      speakerId: string;
      speakerName: string;
      speakerType: "human" | "agent";
      message: string;
      timestamp: number;
      color?: string;
    }>
  ): void {
    const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
    for (const e of sorted) {
      const trimmed = e.message.trim();
      if (!trimmed) continue;
      const displayOrder = ++this.nextDisplayOrder;
      const color = e.color;

      if (e.speakerType === "human" || e.speakerId === "human") {
        this.humanLines.push({
          id: `hist-human-${displayOrder}`,
          agentId: e.speakerId,
          agentName: e.speakerName,
          color: color ?? "#60a5fa",
          visibleText: trimmed,
          fullText: trimmed,
          pending: false,
          displayOrder,
        });
        continue;
      }

      const segmentId = ++this.segmentCounter;
      this.segments.push({
        segmentId,
        agentId: e.speakerId,
        agentName: e.speakerName,
        startAt: 0,
        endAt: 0,
        durationSec: 0,
        draftText: trimmed,
        finalText: trimmed,
        partial: false,
        closed: true,
        isEngagement: false,
        displayOrder,
      });
      this.lines.set(segmentId, {
        id: `hist-seg-${segmentId}`,
        agentId: e.speakerId,
        agentName: e.speakerName,
        color,
        visibleText: trimmed,
        fullText: trimmed,
        pending: false,
        live: false,
        displayOrder,
      });
      this.lastVisibleBySegment.set(segmentId, trimmed);
    }
  }

  /** Advance visible text to match the audio clock. Returns true if anything changed. */
  tick(now: number): boolean {
    let changed = false;

    for (const seg of this.segments) {
      if (seg.partial) continue;

      const line = this.lines.get(seg.segmentId);
      if (!line) continue;

      const fullText = (seg.finalText ?? seg.draftText).trim();
      line.fullText = fullText;
      line.agentName = seg.agentName;

      if (!fullText) {
        line.pending = now < seg.startAt;
        line.live = false;
        continue;
      }

      if (now < seg.startAt) {
        if (line.visibleText !== "" || !line.pending) {
          line.visibleText = "";
          line.pending = true;
          line.live = false;
          changed = true;
          this.lastVisibleBySegment.set(seg.segmentId, "");
        }
        continue;
      }

      const progress =
        seg.endAt > seg.startAt
          ? Math.min(1, Math.max(0, (now - seg.startAt) / (seg.endAt - seg.startAt)))
          : 1;

      const visible = revealTextByProgress(fullText, progress);
      const isLive = progress > 0 && progress < 0.995;

      if (visible !== this.lastVisibleBySegment.get(seg.segmentId)) {
        line.visibleText = visible;
        line.pending = visible.length === 0;
        line.live = isLive;
        this.lastVisibleBySegment.set(seg.segmentId, visible);
        changed = true;
      } else if (line.live !== isLive) {
        line.live = isLive;
        changed = true;
      }

      if (progress >= 0.995 && seg.closed) {
        line.live = false;
      }
    }

    return changed;
  }

  getDisplayLines(): TranscriptDisplayLine[] {
    const agentLines = this.segments
      .map((s) => this.lines.get(s.segmentId))
      .filter((l): l is TranscriptDisplayLine => {
        if (!l) return false;
        // Never show a queued agent turn until its audio begins revealing text.
        return l.visibleText.length > 0 || Boolean(l.partial);
      });

    return [...agentLines, ...this.humanLines]
      .filter((l) => l.visibleText.length > 0 || Boolean(l.partial))
      .sort((a, b) => a.displayOrder - b.displayOrder);
  }

  /** Active speaker from the audio clock (not server events). */
  getHeardAgentId(now: number): string | null {
    for (const seg of this.segments) {
      if (seg.partial) continue;
      if (now >= seg.startAt && now < seg.endAt) return seg.agentId;
    }
    return null;
  }

  clear(): void {
    this.segments = [];
    this.lines.clear();
    this.lastVisibleBySegment.clear();
    this.unboundText.clear();
    this.humanLines = [];
    this.nextDisplayOrder = 0;
  }

  /** Drop unheard queued segments; freeze partial text for the segment currently playing. */
  flushAtTime(now: number): void {
    const keep: PlayoutSegment[] = [];

    for (const seg of this.segments) {
      if (seg.endAt <= now || seg.partial) {
        keep.push(seg);
        continue;
      }

      if (now >= seg.startAt) {
        const fullText = (seg.finalText ?? seg.draftText).trim();
        const progress =
          seg.endAt > seg.startAt
            ? Math.min(1, Math.max(0, (now - seg.startAt) / (seg.endAt - seg.startAt)))
            : 1;
        const visible = revealTextByProgress(fullText, progress);
        seg.partial = true;
        seg.closed = true;
        seg.finalText = visible || fullText;
        const line = this.lines.get(seg.segmentId);
        if (line) {
          line.visibleText = visible;
          line.fullText = seg.finalText;
          line.partial = true;
          line.pending = false;
          line.live = false;
        }
        keep.push(seg);
      } else {
        this.lines.delete(seg.segmentId);
        this.lastVisibleBySegment.delete(seg.segmentId);
      }
    }

    this.segments = keep;
  }

  private unboundKey(agentId: string, isEngagement: boolean): string {
    return `${agentId}:${isEngagement ? "engage" : "main"}`;
  }

  private findOpenSegment(
    agentId: string,
    isEngagement: boolean
  ): PlayoutSegment | undefined {
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const seg = this.segments[i]!;
      if (seg.agentId === agentId && seg.isEngagement === isEngagement && !seg.partial && !seg.closed) {
        return seg;
      }
    }
    return undefined;
  }

  private findLatestSegment(
    agentId: string,
    isEngagement: boolean
  ): PlayoutSegment | undefined {
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const seg = this.segments[i]!;
      if (seg.agentId === agentId && seg.isEngagement === isEngagement) return seg;
    }
    return undefined;
  }
}
