import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getEnv } from "@/lib/env";
import { rateLimit } from "@/lib/helpers/rate-limit";
import { getClientIp } from "@/lib/guest/session";
import { generateStructuredJson } from "@/lib/pipeline/geminiChat";
import { buildPlannerPrompt } from "@/lib/prompts/prompts";
import { AGENT_COLORS, PLANNER_VOICE_POOL } from "@/lib/config/agentPlanning";

interface PlannedAgent {
  name: string;
  systemPrompt: string;
  roleSummary: string;
  description: string;
}

interface PlannerResponse {
  refinedPrompt: string;
  topic: string;
  goal: string;
  context: string;
  instructions: string;
  agents: PlannedAgent[];
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const limited = rateLimit(`plan-agents:${ip}`, 10, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a moment." },
      { status: 429 }
    );
  }

  let body: { prompt?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const prompt = body.prompt?.trim();
  if (!prompt || prompt.length < 10) {
    return NextResponse.json(
      { error: "Please provide a prompt of at least 10 characters." },
      { status: 400 }
    );
  }

  try {
    const env = getEnv();
    const minAgents = env.GUEST_MIN_AGENTS;
    const planner = buildPlannerPrompt({ userPrompt: prompt, minAgents });
    const result = await generateStructuredJson<PlannerResponse>({
      modelOverride: env.GEMINI_PLANNER_MODEL,
      systemPrompt: planner.system,
      userPrompt: planner.user,
    });

    const agents = (result.agents ?? []).slice(0, minAgents).map((agent, i) => ({
      id: randomUUID(),
      name: agent.name,
      systemPrompt: agent.systemPrompt,
      roleSummary: agent.roleSummary,
      description: agent.description,
      voice: PLANNER_VOICE_POOL[i % PLANNER_VOICE_POOL.length],
      color: AGENT_COLORS[i % AGENT_COLORS.length],
    }));

    if (agents.length < minAgents) {
      return NextResponse.json(
        { error: `Could not plan ${minAgents} advisors. Please try again.` },
        { status: 502 }
      );
    }

    return NextResponse.json({
      refinedPrompt: result.refinedPrompt,
      topic: result.topic ?? "",
      goal: result.goal ?? "",
      context: result.context ?? "",
      instructions: result.instructions ?? "",
      agents,
    });
  } catch (err) {
    console.error("plan-agents error:", err);
    return NextResponse.json(
      { error: "Failed to plan advisors. Please try again." },
      { status: 502 }
    );
  }
}
