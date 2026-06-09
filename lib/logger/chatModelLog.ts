import fs from "fs";
import path from "path";
import { logger } from "./core";

export type ChatModelOperation =
  | "chat"
  | "structured_json"
  | "routing_json"
  | "merged_turn";

export interface ChatModelHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyRaw: string;
  body: unknown;
}

export interface ChatModelHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyRaw: string;
  body: unknown;
}

export interface ChatModelHttpCapture {
  request: ChatModelHttpRequest;
  response: ChatModelHttpResponse | null;
}

export interface ChatModelExchangeDetails {
  operation: ChatModelOperation;
  model: string;
  success: boolean;
  error?: string | null;
  elapsedMs?: number;
  http: ChatModelHttpCapture;
}

/** @deprecated Use ChatModelExchangeDetails */
export type ChatModelErrorDetails = Omit<ChatModelExchangeDetails, "success"> & {
  error: string;
};

const EXCHANGE_FILENAME = "gemini-errors.json";

function resolveLogsDir(): string {
  return path.join(path.resolve(__dirname, "../.."), "server", "logs");
}

function istTimestamps(now = new Date()): { timestampIst: string; timestampIso: string } {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((p) => [p.type, p.value])
  );
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  const timestampIst = `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}.${ms} IST`;
  const timestampIso = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${ms}+05:30`;
  return { timestampIst, timestampIso };
}

function buildExchangeRecord(details: ChatModelExchangeDetails): Record<string, unknown> {
  const { timestampIst, timestampIso } = istTimestamps();
  return {
    timestampIst,
    timestampIso,
    operation: details.operation,
    model: details.model,
    success: details.success,
    error: details.error ?? null,
    elapsedMs: details.elapsedMs ?? null,
    http: details.http,
  };
}

function formatConsoleMessage(details: ChatModelExchangeDetails): string {
  const status = details.success ? "ok" : "failed";
  const elapsed = details.elapsedMs != null ? ` ${details.elapsedMs}ms` : "";
  const httpStatus = details.http.response?.status;
  const httpPart = httpStatus != null ? ` HTTP ${httpStatus}` : "";
  const errPart = details.error ? `: ${details.error}` : "";
  return `${details.operation} ${status} (${details.model})${httpPart}${elapsed}${errPart}`;
}

/** Append one exchange record to logs/gemini-errors.json (newline-delimited JSON). */
function appendGeminiExchangeFile(record: Record<string, unknown>): void {
  try {
    const dir = resolveLogsDir();
    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, EXCHANGE_FILENAME);
    fs.appendFileSync(filepath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    logger.warn(
      "CHAT_MODEL",
      `Failed to append ${EXCHANGE_FILENAME}: ${(err as Error).message}`
    );
  }
}

/** Full HTTP req/response for every Gemini generateContent call. */
export function logChatModelExchange(details: ChatModelExchangeDetails): void {
  appendGeminiExchangeFile(buildExchangeRecord(details));

  const message = formatConsoleMessage(details);
  if (details.success) {
    logger.api("CHAT_MODEL", message);
  } else {
    logger.error("CHAT_MODEL", message);
  }
}

/** @deprecated Prefer logChatModelExchange */
export function logChatModelError(details: ChatModelErrorDetails): void {
  logChatModelExchange({
    ...details,
    success: false,
  });
}
