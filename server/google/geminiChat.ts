import { GoogleGenAI } from "@google/genai";
import { getEnv } from "../../lib/env";
import { CHAT_TUNING } from "../../lib/config/pipeline";
import { logger } from "../logger";
let genAI: GoogleGenAI | null = null;

type GeminiErrorPayload = {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    details?: Array<{ reason?: string; metadata?: Record<string, string> }>;
  };
};

function getGenAI(): GoogleGenAI {
  if (!genAI) {
    const env = getEnv();
    if (!env.GOOGLE_APPLICATION_CREDENTIALS) {
      throw new Error("GOOGLE_APPLICATION_CREDENTIALS is required for Vertex AI Gemini");
    }
    genAI = new GoogleGenAI({
      vertexai: true,
      project: env.GCP_PROJECT_ID,
      location: "global",
      googleAuthOptions: {
        keyFilename: env.GOOGLE_APPLICATION_CREDENTIALS,
      },
    });
  }
  return genAI;
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

  // Walk forward to find the matching closing brace
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
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

/**
 * Generate agent response text using Gemini Flash.
 */
export async function generateAgentResponse(
  input: GenerateAgentResponseInput
): Promise<string> {
  const env = getEnv();
  const ai = getGenAI();

  const history = input.conversationHistory.map((m) => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));

  const chat = ai.chats.create({
    model: env.GEMINI_CHAT_MODEL,
    history,
    config: {
      systemInstruction: `${input.systemPrompt}\n\n${CHAT_TUNING.systemPromptAppend}`,
    },
  });

  const prompt = input.extraInstructions
    ? input.extraInstructions
    : "Respond naturally to the conversation. Keep it brief for voice.";

  let text = "";
  try {
    const result = await chat.sendMessage({ message: prompt });
    text = result.text?.trim() ?? "";
  } catch (err) {
    throw formatGeminiError(err, "chat", env.GEMINI_CHAT_MODEL);
  }

  logger.info("GEMINI", `Agent response: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);
  return text;
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
  const env = getEnv();
  const modelName = input.modelOverride ?? env.GEMINI_CHAT_MODEL;
  const ai = getGenAI();

  let result;
  try {
    result = await ai.models.generateContent({
      model: modelName,
      contents: input.userPrompt,
      config: {
        systemInstruction: input.systemPrompt,
        responseMimeType: "application/json",
        temperature: 0.7,
        maxOutputTokens: 4096,
      },
    });
  } catch (err) {
    throw formatGeminiError(err, "structured_json", modelName);
  }

  const raw = result.text?.trim() ?? "";
  return extractJsonObject(raw) as T;
}

/**
 * Simple one-shot Gemini text generation for routing etc.
 */
export async function generateJsonReply(
  system: string,
  user: string,
  modelOverride?: string
): Promise<Record<string, unknown>> {
  const env = getEnv();
  const ai = getGenAI();

  const modelName = modelOverride ?? env.GEMINI_ROUTING_MODEL;
  let result;
  try {
    result = await ai.models.generateContent({
      model: modelName,
      contents: user,
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        temperature: 0.15,
        maxOutputTokens: 256,
        // Thinking models (e.g. gemini-3.5-flash) consume the token budget on
        // internal reasoning; disable for tiny JSON routing responses.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
  } catch (err) {
    throw formatGeminiError(err, "routing_json", modelName);
  }

  const raw = result.text?.trim() ?? "";
  if (!raw) {
    const finish = result.candidates?.[0]?.finishReason ?? "unknown";
    throw new Error(`Empty JSON response (finishReason=${finish})`);
  }

  return extractJsonObject(raw);
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
}

/**
 * Pick the next speaker and generate their spoken reply in one Gemini call.
 */
export async function pickSpeakerAndRespond(
  input: PickSpeakerAndRespondInput
): Promise<Record<string, unknown>> {
  const env = getEnv();
  const ai = getGenAI();
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
          `- "response" MUST be that agent's spoken reply (non-empty, first person, under 60 words).`,
        ].join("\n")
      : [
          `chain (agent-to-agent or handoff):`,
          `- Pick who should SPEAK next — not who is being discussed.`,
          `- Set "next" to "${human}" or "human" ONLY when the last speaker was an AGENT who asked ${human} a direct question that needs ${human}'s answer — leave "response" empty.`,
          `- Set "next" to "random" only when the floor is genuinely open — leave "response" empty.`,
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

Reply with JSON only: {"next":"<AgentFirstName|${human}|human|random>","reason":"<max 12 words>","response":"<spoken line or empty>"}`;

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

  const user = userPrompt.filter(Boolean).join("\n");

  const modelName = env.GEMINI_CHAT_MODEL;
  let result;
  try {
    result = await ai.models.generateContent({
      model: modelName,
      contents: user,
      config: {
        systemInstruction: `${system}\n\n${CHAT_TUNING.systemPromptAppend}`,
        responseMimeType: "application/json",
        temperature: CHAT_TUNING.temperature,
        maxOutputTokens: Math.max(CHAT_TUNING.maxTokens, 1024),
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
  } catch (err) {
    throw formatGeminiError(err, "merged_turn", modelName);
  }

  const raw = result.text?.trim() ?? "";
  if (!raw) {
    const finish = result.candidates?.[0]?.finishReason ?? "unknown";
    throw new Error(`Empty merged turn response (finishReason=${finish})`);
  }

  return extractJsonObject(raw);
}
