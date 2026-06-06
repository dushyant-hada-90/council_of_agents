/**
 * Centralized structured logger with color-coded output, timestamps, and latency tracking.
 * All output goes to stdout. No external dependencies — uses ANSI escape codes directly.
 */

// ─── ANSI color codes ────────────────────────────────────────────────────────
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const FG_WHITE = "\x1b[37m";
const FG_CYAN = "\x1b[36m";
const FG_GREEN = "\x1b[32m";
const FG_YELLOW = "\x1b[33m";
const FG_RED = "\x1b[31m";
const FG_MAGENTA = "\x1b[35m";
const FG_BLUE = "\x1b[34m";
const FG_BRIGHT_CYAN = "\x1b[96m";
const FG_BRIGHT_GREEN = "\x1b[92m";
const FG_BRIGHT_YELLOW = "\x1b[93m";
const FG_BRIGHT_RED = "\x1b[91m";
const FG_BRIGHT_MAGENTA = "\x1b[95m";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG" | "METRIC" | "EVENT" | "STATE";

/** minimal = errors + warnings only (default); verbose = everything */
type LogMode = "minimal" | "verbose";

function getLogMode(): LogMode {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw === "verbose" || raw === "info" || raw === "debug") return "verbose";
  return "minimal";
}

function shouldEmit(level: LogLevel): boolean {
  if (getLogMode() === "verbose") return true;
  return level === "ERROR" || level === "WARN";
}

interface LevelConfig {
  label: string;
  color: string;
}

const LEVEL_CONFIG: Record<LogLevel, LevelConfig> = {
  INFO:   { label: " INFO ", color: FG_BRIGHT_CYAN },
  WARN:   { label: " WARN ", color: FG_BRIGHT_YELLOW },
  ERROR:  { label: "ERROR ", color: FG_BRIGHT_RED },
  DEBUG:  { label: "DEBUG ", color: DIM + FG_WHITE },
  METRIC: { label: "METRIC", color: FG_BRIGHT_GREEN },
  EVENT:  { label: "EVENT ", color: FG_MAGENTA },
  STATE:  { label: "STATE ", color: FG_YELLOW },
};

// Component name → display color mapping
const COMPONENT_COLORS: Record<string, string> = {
  GATEWAY:     FG_CYAN,
  ORCHESTRATOR: FG_YELLOW,
  MIXER:       FG_GREEN,
  SESSION:     FG_BLUE,
  OPENAI:      FG_MAGENTA,
  SYSTEM:      FG_WHITE,
  RECORDER:    FG_BRIGHT_MAGENTA,
  TRANSCRIBE:  FG_BLUE,
  GROQ:        FG_GREEN,
};

/** Returns [HH:MM:SS.mmm] timestamp string */
function getTimestamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function colorizeComponent(component: string): string {
  const color = COMPONENT_COLORS[component] ?? FG_BRIGHT_CYAN;
  return `${color}${BOLD}[${component}]${RESET}`;
}

function colorizeLevel(level: LogLevel): string {
  const cfg = LEVEL_CONFIG[level];
  return `${cfg.color}${BOLD}[${cfg.label}]${RESET}`;
}

/** Core log function — all other helpers delegate here */
function log(level: LogLevel, component: string, message: string, extra?: unknown): void {
  if (!shouldEmit(level)) return;

  const ts = `${DIM}[${getTimestamp()}]${RESET}`;
  const lvl = colorizeLevel(level);
  const comp = colorizeComponent(component);
  const msg = `${FG_WHITE}${message}${RESET}`;

  let line = `${ts} ${lvl} ${comp} ${msg}`;

  if (extra !== undefined) {
    const extraStr =
      typeof extra === "object"
        ? JSON.stringify(extra, null, 0)
        : String(extra);
    line += ` ${DIM}${extraStr}${RESET}`;
  }

  process.stdout.write(line + "\n");
}

// ─── Latency tracker ─────────────────────────────────────────────────────────

/** Active latency measurements keyed by a string label */
const latencyMarks = new Map<string, number>();

/**
 * Start timing an event. Call `logLatency(label)` later to emit the result.
 */
export function startTimer(label: string): void {
  if (!shouldEmit("METRIC")) return;
  latencyMarks.set(label, performance.now());
}

/**
 * End timing and log the elapsed time in milliseconds.
 * Returns the elapsed ms, or -1 if the timer was never started.
 */
export function logLatency(component: string, label: string): number {
  if (!shouldEmit("METRIC")) return -1;

  const start = latencyMarks.get(label);
  if (start === undefined) {
    log("WARN", component, `Timer '${label}' was never started`);
    return -1;
  }
  const elapsed = performance.now() - start;
  latencyMarks.delete(label);
  log(
    "METRIC",
    component,
    `${FG_BRIGHT_GREEN}⏱  ${label}${RESET} → ${BOLD}${elapsed.toFixed(2)} ms${RESET}`
  );
  return elapsed;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export const logger = {
  info(component: string, message: string, extra?: unknown): void {
    log("INFO", component, message, extra);
  },

  warn(component: string, message: string, extra?: unknown): void {
    log("WARN", component, message, extra);
  },

  error(component: string, message: string, extra?: unknown): void {
    log("ERROR", component, message, extra);
  },

  debug(component: string, message: string, extra?: unknown): void {
    // Suppress debug logs in production
    if (process.env.NODE_ENV === "production") return;
    log("DEBUG", component, message, extra);
  },

  /** Log an orchestrator FSM state transition */
  state(from: string, to: string, reason?: string): void {
    const arrow = `${FG_YELLOW}${from}${RESET} → ${FG_BRIGHT_YELLOW}${BOLD}${to}${RESET}`;
    const detail = reason ? ` ${DIM}(${reason})${RESET}` : "";
    log("STATE", "ORCHESTRATOR", `State: ${arrow}${detail}`);
  },

  /** Log an OpenAI Realtime API WebSocket event (sent or received) */
  wsEvent(
    direction: "SENT" | "RECV",
    agentId: string,
    eventType: string,
    extra?: unknown
  ): void {
    const dir =
      direction === "SENT"
        ? `${FG_GREEN}▲ SENT ${RESET}`
        : `${FG_BLUE}▼ RECV ${RESET}`;
    log("EVENT", "OPENAI", `${dir}[${agentId}] ${BOLD}${eventType}${RESET}`, extra);
  },

  /** Log a client ↔ gateway WebSocket event */
  gatewayEvent(direction: "IN" | "OUT", eventType: string, extra?: unknown): void {
    const dir =
      direction === "IN"
        ? `${FG_CYAN}← IN  ${RESET}`
        : `${FG_MAGENTA}→ OUT ${RESET}`;
    log("EVENT", "GATEWAY", `${dir}${BOLD}${eventType}${RESET}`, extra);
  },

  /** Log audio routing info (kept brief to avoid log spam) */
  audioRoute(from: string, to: string, bytes: number): void {
    log(
      "DEBUG",
      "MIXER",
      `${DIM}audio ${from} → ${to} (${bytes}B)${RESET}`
    );
  },

  startTimer,
  logLatency,
};

export default logger;
