import { NextRequest, NextResponse } from "next/server";
import { requireUser, getDb } from "@/lib/supabase/server";

type Params = { params: Promise<{ meetingId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { meetingId } = await params;
    const user = await requireUser();
    const db = getDb();

    const { data: meeting, error: meetingError } = await db
      .from("meetings")
      .select("*")
      .eq("id", meetingId)
      .eq("user_id", user.id)
      .single();

    if (meetingError || !meeting) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { data: messages, error: msgError } = await db
      .from("transcript_messages")
      .select("*")
      .eq("meeting_id", meetingId)
      .order("message_timestamp", { ascending: true });

    if (msgError) return NextResponse.json({ error: msgError.message }, { status: 500 });

    return NextResponse.json({ meeting, messages: messages ?? [] });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
