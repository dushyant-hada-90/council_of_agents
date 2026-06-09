import { getEnv } from "@/lib/env";
import { CHAT_TUNING } from "@/lib/config/pipeline";
import {
  appendChatVoiceRules,
  buildLiveTurnPrompt,
  formatLiveMeetingMetadata,
  JSON_SYSTEM_SUFFIX,
  type LiveMeetingMetadata,
} from "@/lib/prompts/prompts";
import { logger } from "@/lib/logger";
import { logApiError, logApiRequest, logApiResponse, previewText } from "@/lib/logger/apiLog";
import {
  logChatModelExchange,
  type ChatModelHttpCapture,
  type ChatModelOperation,
} from "@/lib/logger/chatModelLog";

const GOOGLE_SEARCH_TOOLS = [{ googleSearch: {} }] as const;

const API_ENDPOINT = "aiplatform.googleapis.com";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

function getChatModel(override?: string): string {
  return override ?? getEnv().GEMINI_CHAT_MODEL ?? DEFAULT_GEMINI_MODEL;
}

const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
];

type Content = { role: string; parts: Array<{ text: string }> };

type GeminiGenerateBody = {
  contents: Content[];
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig: Record<string, unknown>;
  safetySettings: typeof SAFETY_SETTINGS;
  tools?: Array<{ googleSearch: Record<string, never> }>;
};

type GeminiErrorPayload = {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    details?: Array<{ reason?: string; metadata?: Record<string, string> }>;
  };
};

function getApiKey(): string {
  const { GOOGLE_API_KEY } = getEnv();
  if (!GOOGLE_API_KEY) {
    throw new Error("GOOGLE_API_KEY is required");
  }
  return GOOGLE_API_KEY;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function parseResponseBody(bodyRaw: string): unknown {
  if (!bodyRaw) return null;
  try {
    return JSON.parse(bodyRaw) as unknown;
  } catch (parseErr) {
    return {
      _jsonParseFailed: true,
      _parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
      _raw: bodyRaw,
    };
  }
}

type GeminiPostResult = {
  data: Record<string, unknown>;
  http: ChatModelHttpCapture;
};

async function geminiPost(
  model: string,
  body: GeminiGenerateBody,
  operation: ChatModelOperation,
  startedAt: number,
  signal?: AbortSignal
): Promise<GeminiPostResult> {
  const url = `https://${API_ENDPOINT}/v1/publishers/google/models/${model}:generateContent?key=${getApiKey()}`;
  const requestHeaders = { "Content-Type": "application/json" };
  const bodyRaw = JSON.stringify(body);

  const http: ChatModelHttpCapture = {
    request: {
      method: "POST",
      url,
      headers: requestHeaders,
      bodyRaw,
      body,
    },
    response: null,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: requestHeaders,
      body: bodyRaw,
      signal,
    });

    const responseBodyRaw = await res.text();
    const parsedBody = parseResponseBody(responseBodyRaw);
    const data = (
      parsedBody && typeof parsedBody === "object" && !("_jsonParseFailed" in (parsedBody as object))
        ? parsedBody
        : { _raw: responseBodyRaw, _parsed: parsedBody }
    ) as Record<string, unknown>;

    http.response = {
      status: res.status,
      statusText: res.statusText,
      headers: headersToRecord(res.headers),
      bodyRaw: responseBodyRaw,
      body: parsedBody,
    };

    const elapsedMs = Math.round(performance.now() - startedAt);

    if (!res.ok) {
      const error =
        typeof data.error === "object" && data.error && "message" in data.error
          ? String((data.error as { message?: string }).message)
          : `HTTP ${res.status}`;
      logChatModelExchange({
        operation,
        model,
        http,
        success: false,
        error,
        elapsedMs,
      });
      throw new Error(JSON.stringify(data));
    }

    logChatModelExchange({
      operation,
      model,
      http,
      success: true,
      elapsedMs,
    });

    return { data, http };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    if (err instanceof Error && err.message.startsWith("{")) {
      throw err;
    }
    logChatModelExchange({
      operation,
      model,
      http,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    throw err;
  }
}

function logGeminiLogicalError(
  operation: ChatModelOperation,
  model: string,
  error: string,
  startedAt: number,
  http: ChatModelHttpCapture
): void {
  logChatModelExchange({
    operation,
    model,
    http,
    success: false,
    error,
    elapsedMs: Math.round(performance.now() - startedAt),
  });
}

function userOnlyContents(userText: string): Content[] {
  return [{ role: "user", parts: [{ text: userText }] }];
}

function googleSearchGroundingEnabled(operation: ChatModelOperation): boolean {
  const env = getEnv();
  if (!env.GEMINI_GOOGLE_SEARCH_GROUNDING) return false;
  const allowed = env.GEMINI_GOOGLE_SEARCH_OPERATIONS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(operation);
}

function buildGeminiBody(
  systemPrompt: string,
  contents: Content[],
  generationConfig: Record<string, unknown>,
  operation: ChatModelOperation
): GeminiGenerateBody {
  const body: GeminiGenerateBody = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig,
    safetySettings: SAFETY_SETTINGS,
  };
  if (googleSearchGroundingEnabled(operation)) {
    body.tools = [...GOOGLE_SEARCH_TOOLS];
  }
  return body;
}

const NO_THINKING = { thinkingConfig: { thinkingBudget: 0 } };

function baseGenerationConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    temperature: 0.7,
    maxOutputTokens: 65535,
    topP: 0.95,
    ...overrides,
  };
}

function extractTextFromResponse(data: Record<string, unknown>): string {
  const candidates = data.candidates as
    | Array<{ content?: { parts?: Array<{ text?: string }> } }>
    | undefined;
  const parts = candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? "").join("").trim();
}

function getFinishReason(data: Record<string, unknown>): string {
  const candidates = data.candidates as Array<{ finishReason?: string }> | undefined;
  return candidates?.[0]?.finishReason ?? "unknown";
}

function formatGeminiError(
  err: unknown,
  operation: "chat" | "structured_json" | "routing_json" | "merged_turn",
  model: string
): Error {
  const message = err instanceof Error ? err.message : String(err);
  let payload: GeminiErrorPayload | null = null;
  try {
    payload = JSON.parse(message) as GeminiErrorPayload;
  } catch {
    payload = null;
  }

  const code = payload?.error?.code;
  const status = payload?.error?.status;
  const providerMessage = payload?.error?.message;
  const details = payload?.error?.details ?? [];
  const reason = details.find((d) => d.reason)?.reason;
  const metadata = details.find((d) => d.metadata)?.metadata;

  const summaryParts = [
    "Gemini request failed",
    `op=${operation}`,
    `model=${model}`,
    code ? `code=${code}` : null,
    status ? `status=${status}` : null,
    reason ? `reason=${reason}` : null,
  ].filter(Boolean);

  const detailBits = [
    metadata?.consumer ? `consumer=${metadata.consumer}` : null,
    metadata?.service ? `service=${metadata.service}` : null,
    metadata?.methodName ? `method=${metadata.methodName}` : null,
    providerMessage ?? message,
  ].filter(Boolean);

  const fullMessage = `${summaryParts.join(" | ")} | ${detailBits.join(" | ")}`;
  logger.warn("GEMINI", fullMessage);
  return new Error(fullMessage);
}

/**
 * Extract the first complete JSON object from a string.
 * Guards against Gemini appending trailing text after the JSON.
 */
function extractJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  if (start === -1) {
    throw new Error(`No JSON object found in response: ${raw.slice(0, 120)}`);
  }

  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) {
    throw new Error(`Unclosed JSON object in response: ${raw.slice(0, 120)}`);
  }

  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
}

export interface StructuredJsonInput {
  systemPrompt: string;
  userPrompt: string;
  modelOverride?: string;
}

/**
 * Call Gemini with JSON response expectation.
 */
export async function generateStructuredJson<T>(
  input: StructuredJsonInput
): Promise<T> {
  const modelName = getChatModel(input.modelOverride);

  const reqStarted = logApiRequest(
    "GEMINI",
    "structured_json",
    `model=${modelName}, user="${previewText(input.userPrompt, 60)}"`
  );

  const body = buildGeminiBody(
    `${input.systemPrompt}\n\n${JSON_SYSTEM_SUFFIX}`,
    userOnlyContents(input.userPrompt),
    baseGenerationConfig({
      maxOutputTokens: 4096,
      ...NO_THINKING,
    }),
    "structured_json"
  );

  try {
    const { data, http } = await geminiPost(modelName, body, "structured_json", reqStarted);
    const raw = extractTextFromResponse(data);
    if (!raw) {
      const finish = getFinishReason(data);
      logApiResponse("GEMINI", reqStarted, "structured_json", `empty (finishReason=${finish})`);
      logGeminiLogicalError(
        "structured_json",
        modelName,
        `Empty structured_json response (finishReason=${finish})`,
        reqStarted,
        http
      );
      throw new Error(`Empty structured_json response (finishReason=${finish})`);
    }
    logApiResponse("GEMINI", reqStarted, "structured_json", `${raw.length} chars JSON`);
    try {
      return extractJsonObject(raw) as T;
    } catch (parseErr) {
      logGeminiLogicalError(
        "structured_json",
        modelName,
        (parseErr as Error).message,
        reqStarted,
        http
      );
      throw parseErr;
    }
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith("Empty structured_json"))) {
      if (
        err instanceof Error &&
        !err.message.startsWith("No JSON object") &&
        !err.message.startsWith("Unclosed JSON")
      ) {
        logApiError("GEMINI", reqStarted, "structured_json", err.message);
      }
    }
    if (err instanceof Error && err.message.startsWith("Empty structured_json")) throw err;
    if (
      err instanceof Error &&
      (err.message.startsWith("No JSON object") || err.message.startsWith("Unclosed JSON"))
    ) {
      throw err;
    }
    throw formatGeminiError(err, "structured_json", modelName);
  }
}

export interface PickSpeakerAndRespondCandidate {
  id: string;
  name: string;
  systemPrompt: string;
  roleSummary?: string;
  peerProfile?: string;
}

export interface PickSpeakerAndRespondInput {
  humanName: string;
  chatTranscript: string;
  candidates: PickSpeakerAndRespondCandidate[];
  meetingMetadata: LiveMeetingMetadata;
  afterHuman: boolean;
  handoffOnly?: boolean;
  lastSpeakerName?: string;
  lastTranscript?: string;
  signal?: AbortSignal;
}

function trimConversationLines(lines: string, maxLines: number): string {
  const parts = lines.split("\n").filter((line) => line.trim());
  if (parts.length <= maxLines) return lines;
  return parts.slice(-maxLines).join("\n");
}

/**
 * Pick the next speaker and generate their spoken reply in one Gemini call.
 */
const MERGED_TURN_RETRY_LINES_CAP = 6;

async function requestMergedTurn(
  modelName: string,
  systemWithTuning: string,
  user: string,
  thinking: Record<string, unknown>,
  startedAt: number,
  signal?: AbortSignal
): Promise<{
  raw: string;
  finishReason: string;
  body: GeminiGenerateBody;
  data: Record<string, unknown>;
  http: ChatModelHttpCapture;
}> {
  const body = buildGeminiBody(
    systemWithTuning,
    userOnlyContents(user),
    baseGenerationConfig({
      temperature: CHAT_TUNING.temperature,
      maxOutputTokens: Math.max(CHAT_TUNING.maxTokens, 1024),
      ...thinking,
    }),
    "merged_turn"
  );
  const { data, http } = await geminiPost(modelName, body, "merged_turn", startedAt, signal);
  return {
    raw: extractTextFromResponse(data),
    finishReason: getFinishReason(data),
    body,
    data,
    http,
  };
}

export async function pickSpeakerAndRespond(
  input: PickSpeakerAndRespondInput
): Promise<Record<string, unknown>> {
  const modelName = getChatModel();
  const human = input.humanName.trim() || "You";
  const agentNames = input.candidates.map((c) => c.name).join(", ");
  const chatTranscript = input.chatTranscript || "(session just started)";

  const meetingMetadata = formatLiveMeetingMetadata({
    ...input.meetingMetadata,
    agents: input.candidates.map((c) => ({
      name: c.name,
      systemPrompt: c.systemPrompt,
      roleSummary: c.roleSummary,
      peerProfile: c.peerProfile,
    })),
  });

  const liveTurn = buildLiveTurnPrompt({
    humanName: human,
    agentNames,
    afterHuman: input.afterHuman,
    handoffOnly: input.handoffOnly,
    meetingMetadata,
    chatTranscript,
    lastSpeakerName: input.lastSpeakerName,
    lastTranscript: input.lastTranscript,
  });
  const systemWithTuning = appendChatVoiceRules(liveTurn.system);
  const user = liveTurn.user;

  const reqStarted = logApiRequest(
    "GEMINI",
    "merged_turn",
    `model=${modelName}, afterHuman=${input.afterHuman}, handoffOnly=${Boolean(input.handoffOnly)}, agents=${input.candidates.length}`
  );

  try {
    let attempt = await requestMergedTurn(
      modelName,
      systemWithTuning,
      user,
      NO_THINKING,
      reqStarted,
      input.signal
    );
    let { raw, finishReason } = attempt;

    const lineCount = chatTranscript.split("\n").filter((l) => l.trim()).length;
    if (!raw && lineCount > MERGED_TURN_RETRY_LINES_CAP) {
      const trimmedTranscript = trimConversationLines(chatTranscript, MERGED_TURN_RETRY_LINES_CAP);
      const retryUser = user.replace(chatTranscript, trimmedTranscript);
      logger.warn(
        "GEMINI",
        `merged_turn empty (finishReason=${finishReason}) — retrying with conversation ${lineCount}→${MERGED_TURN_RETRY_LINES_CAP} lines`
      );
      attempt = await requestMergedTurn(
        modelName,
        systemWithTuning,
        retryUser,
        NO_THINKING,
        reqStarted,
        input.signal
      );
      ({ raw, finishReason } = attempt);
    }

    if (!raw) {
      logApiResponse("GEMINI", reqStarted, "merged_turn", `empty (finishReason=${finishReason})`);
      logGeminiLogicalError(
        "merged_turn",
        modelName,
        `Empty merged turn response (finishReason=${finishReason})`,
        reqStarted,
        attempt.http
      );
      throw new Error(`Empty merged turn response (finishReason=${finishReason})`);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = extractJsonObject(raw);
    } catch (parseErr) {
      logGeminiLogicalError(
        "merged_turn",
        modelName,
        (parseErr as Error).message,
        reqStarted,
        attempt.http
      );
      throw parseErr;
    }
    if (input.handoffOnly) {
      const handoffPreview =
        typeof parsed.handoff === "string" ? previewText(parsed.handoff, 50) : "(no handoff)";
      logApiResponse("GEMINI", reqStarted, "merged_turn", `handoff="${handoffPreview}"`);
    } else {
      const next = typeof parsed.next === "string" ? parsed.next : "?";
      const responsePreview =
        typeof parsed.response === "string" ? previewText(parsed.response, 50) : "(no response)";
      logApiResponse(
        "GEMINI",
        reqStarted,
        "merged_turn",
        `next=${next}, response="${responsePreview}"`
      );
    }
    return parsed;
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith("Empty merged"))) {
      if (
        err instanceof Error &&
        !err.message.startsWith("No JSON object") &&
        !err.message.startsWith("Unclosed JSON")
      ) {
        logApiError("GEMINI", reqStarted, "merged_turn", err.message);
      }
    }
    if (err instanceof Error && err.message.startsWith("Empty merged")) throw err;
    if (err instanceof Error && err.name === "AbortError") throw err;
    if (
      err instanceof Error &&
      (err.message.startsWith("No JSON object") || err.message.startsWith("Unclosed JSON"))
    ) {
      throw err;
    }
    throw formatGeminiError(err, "merged_turn", modelName);
  }
}
