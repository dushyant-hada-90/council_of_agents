import { NextRequest, NextResponse } from "next/server";
import { requireUser, getDb } from "@/lib/supabase/server";

export async function GET() {
  try {
    const user = await requireUser();
    const db = getDb();
    const { data, error } = await db
      .from("meetings")
      .select("*, meeting_agents(agent_id)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    const db = getDb();
    const body = await request.json();

    const { data: meeting, error: meetingError } = await db
      .from("meetings")
      .insert({
        user_id: user.id,
        topic: body.topic ?? "",
        goal: body.goal ?? "",
        context: body.context ?? "",
        instructions: body.instructions ?? "",
        max_ai_turns_before_human: body.max_ai_turns_before_human ?? 4,
        status: "scheduled",
      })
      .select()
      .single();

    if (meetingError || !meeting) {
      return NextResponse.json({ error: meetingError?.message ?? "Failed" }, { status: 400 });
    }

    const agentIds: string[] = body.agent_ids ?? [];
    if (agentIds.length > 0) {
      const rows = agentIds.map((agentId: string, i: number) => ({
        meeting_id: meeting.id,
        agent_id: agentId,
        sort_order: i,
      }));
      const { error: junctionError } = await db.from("meeting_agents").insert(rows);
      if (junctionError) {
        await db.from("meetings").delete().eq("id", meeting.id);
        return NextResponse.json({ error: junctionError.message }, { status: 400 });
      }
    }

    return NextResponse.json(meeting, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 401 });
  }
}
