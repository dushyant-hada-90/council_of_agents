import { NextResponse } from "next/server";
import { requireUser, getDb } from "@/lib/supabase/server";

type Props = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Props) {
  try {
    const { id } = await params;
    const user = await requireUser();
    const db = getDb();

    const { data: meeting } = await db
      .from("meetings")
      .select("id, status")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (!meeting) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    let liveRoomEnded = false;
    try {
      const { roomManager } = await import("../../../../../server/roomManager");
      liveRoomEnded = roomManager.endMeeting(id, user.id);
    } catch {
      /* custom server module unavailable — DB-only end */
    }

    if (!liveRoomEnded && meeting.status !== "ended") {
      await db
        .from("meetings")
        .update({ status: "ended", ended_at: new Date().toISOString() })
        .eq("id", id)
        .eq("user_id", user.id);
    } else if (liveRoomEnded) {
      /* roomManager.endMeeting already marked ended via destroy */
    }

    return NextResponse.json({ ok: true, liveRoomEnded });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
