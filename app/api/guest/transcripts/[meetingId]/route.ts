import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/supabase/server";
import { GUEST_SESSION_COOKIE, verifyGuestToken } from "@/lib/auth/token";

type Params = { params: Promise<{ meetingId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { meetingId } = await params;
  const guestToken = request.nextUrl.searchParams.get("token");
  const cookieStore = await cookies();
  const guestSessionId = cookieStore.get(GUEST_SESSION_COOKIE)?.value;

  let verifiedGuest = false;
  if (guestToken) {
    const payload = await verifyGuestToken(guestToken);
    verifiedGuest =
      payload?.meetingId === meetingId &&
      payload.guestSessionId === guestSessionId;
  }

  if (!verifiedGuest) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const { data: meeting, error: meetingError } = await db
    .from("meetings")
    .select("*")
    .eq("id", meetingId)
    .eq("is_guest", true)
    .eq("guest_session_id", guestSessionId!)
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
}
