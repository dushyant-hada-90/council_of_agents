import { NextResponse } from "next/server";
import { getSession, signSession } from "@/lib/auth/session";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Re-sign a short-lived token for WebSocket auth
  const accessToken = await signSession(session);
  return NextResponse.json({ accessToken });
}
