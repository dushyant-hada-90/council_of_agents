import { NextResponse } from "next/server";
import { requireUser, getDb } from "@/lib/supabase/server";

export async function GET() {
  try {
    const user = await requireUser();
    const db = getDb();

    const [agentsRes, meetingsRes, transcriptsRes] = await Promise.all([
      db.from("agents").select("id", { count: "exact", head: true }).eq("user_id", user.id),
      db.from("meetings").select("id, started_at, ended_at, status").eq("user_id", user.id),
      db.from("transcript_messages").select("id", { count: "exact", head: true }).eq("user_id", user.id),
    ]);

    const meetings = meetingsRes.data ?? [];
    const endedMeetings = meetings.filter((m) => m.status === "ended" && m.started_at && m.ended_at);
    const totalConversationMs = endedMeetings.reduce((sum, m) => {
      return sum + (new Date(m.ended_at!).getTime() - new Date(m.started_at!).getTime());
    }, 0);

    return NextResponse.json({
      agentCount: agentsRes.count ?? 0,
      meetingCount: meetings.length,
      transcriptMessageCount: transcriptsRes.count ?? 0,
      totalConversationMinutes: Math.round(totalConversationMs / 60000),
    });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
