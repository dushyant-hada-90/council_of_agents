import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/auth/user";
import { hashPassword, isValidPassword, isValidUsername, verifyPassword } from "@/lib/auth/password";
import { signSession, sessionCookieOptions } from "@/lib/auth/session";

export async function POST(request: NextRequest) {
  const { username, password } = await request.json();

  if (!username || !password) {
    return NextResponse.json({ error: "Username and password required" }, { status: 400 });
  }

  if (!isValidUsername(username)) {
    return NextResponse.json(
      { error: "Username must be 3–32 characters: letters, numbers, underscore only" },
      { status: 400 }
    );
  }

  if (!isValidPassword(password)) {
    return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
  }

  const db = getDb();
  const { data: user, error } = await db
    .from("app_users")
    .select("id, username, password_hash")
    .eq("username", username.toLowerCase())
    .single();

  if (error || !user) {
    return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  }

  const token = await signSession({ userId: user.id, username: user.username });
  const response = NextResponse.json({ ok: true });
  const opts = sessionCookieOptions(token);
  response.cookies.set(opts.name, opts.value, opts);
  return response;
}
