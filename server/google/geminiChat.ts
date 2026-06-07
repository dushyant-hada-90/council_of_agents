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
  return JSON.parse(raw) as T;
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

  return JSON.parse(raw) as Record<string, unknown>;
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
      ? `${human} (the live human) just spoke. Pick which agent should respond to ${human} and write their reply.`
      : "An agent just finished. Pick who should speak next and write their reply for natural back-and-forth.";

  const personas = input.candidates
    .map((c) => `### ${c.name}\n${c.systemPrompt}`)
    .join("\n\n");

  const system = `You are the turn-taking router and voice for a live voice conference.
${contextHint}

Agents (use exact first names in "next"): ${agentNames}
Also present: ${human} (live human with push-to-talk).

Rules:
${recentHint ? `- ${recentHint}` : ""}
- Pick who should SPEAK next — not who is being discussed.
- Write "response" as the chosen speaker's spoken line: first person, brief, under 60 words, natural for voice.
- If the last line was from ${human}, pick the agent ${human} is clearly inviting to respond.
- Set next to "${human}" or "human" only if the last speaker asked ${human} a direct question; leave response empty.
- Set next to "random" only when the floor is genuinely open; leave response empty.
- Never read instructions aloud. Never mention routing or meta-rules.

Agent personas (speak AS the chosen agent):
${personas}

Reply with JSON only: {"next":"<AgentFirstName|${human}|human|random>","reason":"<max 12 words>","response":"<spoken line or empty>"}`;

  const user = [
    `Conversation so far:\n${input.conversationLines || "(session just started)"}`,
    input.lastSpeakerName ? `Last speaker: ${input.lastSpeakerName}` : "",
    input.scenarioHint,
    "\nWho should speak next, and what do they say?",
  ]
    .filter(Boolean)
    .join("\n");

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
        maxOutputTokens: Math.max(CHAT_TUNING.maxTokens, 1024),        thinkingConfig: { thinkingBudget: 0 },
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

  return JSON.parse(raw) as Record<string, unknown>;
}
