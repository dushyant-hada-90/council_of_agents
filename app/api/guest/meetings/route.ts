import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/env";
import { getDb } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/helpers/rate-limit";
import { getClientIp, getOrCreateGuestSessionId } from "@/lib/guest/session";
import {
  GUEST_SESSION_COOKIE,
  guestSessionCookieOptions,
  signGuestToken,
} from "@/lib/auth/token";
import { isGuestIpOverLimit } from "@/lib/supabase/audioUsageTracker";
import type { AgentSnapshot } from "@/lib/supabase/types";

interface CreateGuestMeetingBody {
  originalPrompt: string;
  refinedPrompt: string;
  participantName: string;
  topic: string;
  goal: string;
  context: string;
  instructions: string;
  agents: AgentSnapshot[];
}

function normalizeParticipantName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 40) return null;
  return name;
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const limited = rateLimit(`guest-meeting:${ip}`, 5, 60_000);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  if (await isGuestIpOverLimit(ip)) {
    return NextResponse.json(
      {
        error: "You've reached the free guest audio limit. Please sign up to continue.",
        code: "IP_AUDIO_LIMIT",
      },
      { status: 403 }
    );
  }

  let body: CreateGuestMeetingBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const minAgents = getEnv().GUEST_MIN_AGENTS;
  const participantName = normalizeParticipantName(body.participantName);

  if (!participantName) {
    return NextResponse.json(
      { error: "Please enter your name (1–40 characters)." },
      { status: 400 }
    );
  }

  if (!body.agents?.length || body.agents.length < minAgents) {
    return NextResponse.json(
      { error: `At least ${minAgents} agents required.` },
      { status: 400 }
    );
  }

  const cookieStore = await cookies();
  const guestSessionId = getOrCreateGuestSessionId(
    cookieStore.get(GUEST_SESSION_COOKIE)?.value
  );

  const db = getDb();
  const { data: meeting, error } = await db
    .from("meetings")
    .insert({
      is_guest: true,
      guest_session_id: guestSessionId,
      guest_ip: ip,
      user_id: null,
      original_prompt: body.originalPrompt ?? "",
      refined_prompt: body.refinedPrompt ?? "",
      agents_snapshot: body.agents,
      topic: body.topic ?? "",
      goal: body.goal ?? "",
      context: body.context ?? "",
      instructions: body.instructions ?? "",
      participant_name: participantName,
      max_ai_turns_before_human: getEnv().MAX_AI_TURNS_BEFORE_HUMAN,
      status: "scheduled",
    } as never)
    .select("id")
    .single();

  if (error || !meeting) {
    console.error("guest meeting create error:", error);
    return NextResponse.json({ error: "Failed to create meeting." }, { status: 500 });
  }

  const meetingId = (meeting as { id: string }).id;
  const guestToken = await signGuestToken({ meetingId, guestSessionId });

  const response = NextResponse.json({ meetingId, guestToken });
  response.cookies.set(guestSessionCookieOptions(guestSessionId));
  return response;
}
