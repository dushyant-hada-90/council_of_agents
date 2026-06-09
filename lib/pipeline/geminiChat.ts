import { getEnv } from "@/lib/env";
import { CHAT_TUNING } from "@/lib/config/pipeline";
import { logger } from "@/lib/logger";
import { logApiError, logApiRequest, logApiResponse, previewText } from "@/lib/logger/apiLog";
import {
  logChatModelExchange,
  type ChatModelHttpCapture,
  type ChatModelOperation,
} from "@/lib/logger/chatModelLog";

const API_ENDPOINT = "aiplatform.googleapis.com";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
const JSON_SYSTEM_SUFFIX = "Respond with valid JSON only. No explanation, no markdown.";

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

function buildGeminiBody(
  systemPrompt: string,
  contents: Content[],
  generationConfig: Record<string, unknown>
): GeminiGenerateBody {
  return {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig,
    safetySettings: SAFETY_SETTINGS,
  };
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

export interface ChatMessage {
  role: "user" | "model";
  text: string;
}

export interface GenerateAgentResponseInput {
  systemPrompt: string;
  conversationHistory: ChatMessage[];
  extraInstructions?: string;
}

const CHAT_HISTORY_CAP = 24;
const CHAT_RETRY_HISTORY_CAP = 8;

function buildChatContents(history: ChatMessage[], prompt: string): Content[] {
  return [
    ...history.map((m) => ({
      role: m.role,
      parts: [{ text: m.text }],
    })),
    { role: "user", parts: [{ text: prompt }] },
  ];
}

function trimConversationLines(lines: string, maxLines: number): string {
  const parts = lines.split("\n").filter((line) => line.trim());
  if (parts.length <= maxLines) return lines;
  return parts.slice(-maxLines).join("\n");
}

async function requestChatResponse(
  modelName: string,
  systemPrompt: string,
  history: ChatMessage[],
  prompt: string,
  thinking: Record<string, unknown>,
  startedAt: number
): Promise<{
  text: string;
  finishReason: string;
  body: GeminiGenerateBody;
  data: Record<string, unknown>;
  http: ChatModelHttpCapture;
}> {
  const body = buildGeminiBody(
    systemPrompt,
    buildChatContents(history, prompt),
    baseGenerationConfig({
      temperature: CHAT_TUNING.temperature,
      maxOutputTokens: CHAT_TUNING.maxTokens,
      ...thinking,
    })
  );
  const { data, http } = await geminiPost(modelName, body, "chat", startedAt);
  return {
    text: extractTextFromResponse(data),
    finishReason: getFinishReason(data),
    body,
    data,
    http,
  };
}

/**
 * Generate agent response text using Gemini Flash.
 */
export async function generateAgentResponse(
  input: GenerateAgentResponseInput
): Promise<string> {
  const modelName = getChatModel();
  const prompt = input.extraInstructions
    ? input.extraInstructions
    : "Respond naturally to the conversation. Keep it brief for voice.";
  const systemPrompt = `${input.systemPrompt}\n\n${CHAT_TUNING.systemPromptAppend}`;

  const cappedHistory = input.conversationHistory.slice(-CHAT_HISTORY_CAP);
  const reqStarted = logApiRequest(
    "GEMINI",
    "chat",
    `model=${modelName}, history=${cappedHistory.length}, prompt="${previewText(prompt, 60)}"`
  );

  try {
    let attempt = await requestChatResponse(
      modelName,
      systemPrompt,
      cappedHistory,
      prompt,
      NO_THINKING,
      reqStarted
    );
    let { text, finishReason } = attempt;

    if (!text && cappedHistory.length > CHAT_RETRY_HISTORY_CAP) {
      const trimmedHistory = cappedHistory.slice(-CHAT_RETRY_HISTORY_CAP);
      logger.warn(
        "GEMINI",
        `chat empty (finishReason=${finishReason}) — retrying with history ${cappedHistory.length}→${trimmedHistory.length}`
      );
      attempt = await requestChatResponse(
        modelName,
        systemPrompt,
        trimmedHistory,
        prompt,
        NO_THINKING,
        reqStarted
      );
      ({ text, finishReason } = attempt);
    }

    if (!text) {
      logApiResponse("GEMINI", reqStarted, "chat", `empty (finishReason=${finishReason})`);
      logGeminiLogicalError(
        "chat",
        modelName,
        `Empty chat response (finishReason=${finishReason})`,
        reqStarted,
        attempt.http
      );
      throw new Error(`Empty chat response (finishReason=${finishReason})`);
    }

    logApiResponse("GEMINI", reqStarted, "chat", `"${previewText(text)}"`);
    return text;
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith("Empty chat"))) {
      logApiError("GEMINI", reqStarted, "chat", (err as Error).message);
    }
    if (err instanceof Error && err.message.startsWith("Empty chat")) throw err;
    throw formatGeminiError(err, "chat", modelName);
  }
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
    })
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

/**
 * Simple one-shot Gemini text generation for routing etc.
 */
export async function generateJsonReply(
  system: string,
  user: string,
  modelOverride?: string,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const modelName = getChatModel(modelOverride);
  const reqStarted = logApiRequest(
    "GEMINI",
    "routing_json",
    `model=${modelName}, user="${previewText(user, 60)}"`
  );

  const body = buildGeminiBody(
    `${system}\n\n${JSON_SYSTEM_SUFFIX}`,
    userOnlyContents(user),
    baseGenerationConfig({
      temperature: 0.15,
      maxOutputTokens: 256,
      ...NO_THINKING,
    })
  );

  try {
    const { data, http } = await geminiPost(modelName, body, "routing_json", reqStarted, signal);
    const raw = extractTextFromResponse(data);
    if (!raw) {
      const finish = getFinishReason(data);
      logApiResponse("GEMINI", reqStarted, "routing_json", `empty (finishReason=${finish})`);
      logGeminiLogicalError(
        "routing_json",
        modelName,
        `Empty JSON response (finishReason=${finish})`,
        reqStarted,
        http
      );
      throw new Error(`Empty JSON response (finishReason=${finish})`);
    }
    logApiResponse("GEMINI", reqStarted, "routing_json", `${raw.length} chars JSON`);
    try {
      return extractJsonObject(raw);
    } catch (parseErr) {
      logGeminiLogicalError(
        "routing_json",
        modelName,
        (parseErr as Error).message,
        reqStarted,
        http
      );
      throw parseErr;
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    if (!(err instanceof Error && err.message.startsWith("Empty JSON"))) {
      if (
        err instanceof Error &&
        !err.message.startsWith("No JSON object") &&
        !err.message.startsWith("Unclosed JSON")
      ) {
        logApiError("GEMINI", reqStarted, "routing_json", err.message);
      }
    }
    if (err instanceof Error && err.message.startsWith("Empty JSON")) throw err;
    if (
      err instanceof Error &&
      (err.message.startsWith("No JSON object") || err.message.startsWith("Unclosed JSON"))
    ) {
      throw err;
    }
    throw formatGeminiError(err, "routing_json", modelName);
  }
}

export interface PickSpeakerAndRespondCandidate {
  id: string;
  name: string;
  systemPrompt: string;
}

export interface PickSpeakerAndRespondInput {
  humanName: string;
  conversationLines: string;
  candidates: PickSpeakerAndRespondCandidate[];
  context: "human_turn" | "chain";
  scenarioHint: string;
  lastSpeakerName?: string;
  recentSpeakerNames?: string[];
  signal?: AbortSignal;
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
    })
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

  const recentHint =
    input.recentSpeakerNames && input.recentSpeakerNames.length > 0
      ? `Recently spoke (most recent last): ${input.recentSpeakerNames.join(", ")}.`
      : "";

  const contextHint =
    input.context === "human_turn"
      ? `${human} (the live human) JUST finished speaking on push-to-talk. An AGENT must reply next — not ${human}.`
      : "An agent just finished speaking. Pick who should speak next in the natural back-and-forth.";

  const routingRules =
    input.context === "human_turn"
      ? [
          `CRITICAL — human_turn (human just spoke):`,
          `- "next" MUST be exactly one agent first name from: ${agentNames}.`,
          `- NEVER set "next" to "${human}", "human", "You", or "random" on this turn.`,
          `- ${human} is waiting for an advisor to answer — even if they asked the whole table a question, pick the best-fit agent.`,
          `- If ${human} named an agent, pick that agent.`,
          `- If the floor is open, pick a specific agent first name (prefer someone who has not spoken recently). Never output "random".`,
          `- "response" MUST be that agent's spoken reply (non-empty, first person, under 60 words).`,
        ].join("\n")
      : [
          `chain (agent-to-agent or handoff):`,
          `- Pick who should SPEAK next — not who is being discussed.`,
          `- Set "next" to "${human}" or "human" ONLY when the last speaker was an AGENT who asked ${human} a direct question that needs ${human}'s answer — leave "response" empty.`,
          `- If the floor is open, pick a specific agent first name (prefer someone who has not spoken recently). Never output "random".`,
          `- Otherwise "next" must be an agent first name and "response" must be their spoken line.`,
        ].join("\n");

  const personas = input.candidates
    .map((c) => `### ${c.name}\n${c.systemPrompt}`)
    .join("\n\n");

  const system = `You are the turn-taking router and voice for a live voice conference.
${contextHint}

Agents (use exact first names in "next"): ${agentNames}
Also present: ${human} (live human with push-to-talk — only speaks when they press the button).

${routingRules}
${recentHint ? `- Recently spoke (most recent last): ${recentHint.replace("Recently spoke (most recent last): ", "")}` : ""}
- Never read instructions aloud. Never mention routing or meta-rules.

Agent personas (when you pick an agent, speak AS them in "response"):
${personas}

Reply with JSON only: {"next":"<AgentFirstName|${human}|human>","reason":"<max 12 words>","response":"<spoken line or empty>"}`;

  const userPrompt =
    input.context === "human_turn"
      ? [
          `Conversation so far:\n${input.conversationLines || "(session just started)"}`,
          input.lastSpeakerName ? `Last speaker: ${input.lastSpeakerName}` : `Last speaker: ${human}`,
          input.scenarioHint,
          `\n${human} just spoke. Pick which AGENT replies next and write their line. "next" must be an agent name — not ${human}.`,
        ]
      : [
          `Conversation so far:\n${input.conversationLines || "(session just started)"}`,
          input.lastSpeakerName ? `Last speaker: ${input.lastSpeakerName}` : "",
          input.scenarioHint,
          "\nWho should speak next, and what do they say?",
        ];

  const conversationLines = input.conversationLines || "(session just started)";
  const user = userPrompt.filter(Boolean).join("\n");
  const systemWithTuning = `${system}\n\n${CHAT_TUNING.systemPromptAppend}`;

  const reqStarted = logApiRequest(
    "GEMINI",
    "merged_turn",
    `model=${modelName}, context=${input.context}, agents=${input.candidates.length}`
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

    const lineCount = conversationLines.split("\n").filter((l) => l.trim()).length;
    if (!raw && lineCount > MERGED_TURN_RETRY_LINES_CAP) {
      const trimmedLines = trimConversationLines(conversationLines, MERGED_TURN_RETRY_LINES_CAP);
      const retryUser = user.replace(conversationLines, trimmedLines);
      logger.warn(
        "GEMINI",
        `merged_turn empty (finishReason=${finishReason}) — retrying with conversation ${lineCount}→${MERGED_TURN_RETRY_LINES_CAP} lines, NO_THINKING`
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
    const next = typeof parsed.next === "string" ? parsed.next : "?";
    const responsePreview =
      typeof parsed.response === "string" ? previewText(parsed.response, 50) : "(no response)";
    logApiResponse(
      "GEMINI",
      reqStarted,
      "merged_turn",
      `next=${next}, response="${responsePreview}"`
    );
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
