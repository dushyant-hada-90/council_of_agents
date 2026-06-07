import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/auth/user";
import { hashPassword, isValidPassword, isValidUsername } from "@/lib/auth/password";
import { signSession, sessionCookieOptions } from "@/lib/auth/session";

export async function POST(request: NextRequest) {
  const { username, password, displayName } = await request.json();

  if (!username || !password) {
    return NextResponse.json({ error: "Username and password required" }, { status: 400 });
  }

  const normalizedUsername = String(username).toLowerCase().trim();

  if (!isValidUsername(normalizedUsername)) {
    return NextResponse.json(
      { error: "Username must be 3–32 characters: letters, numbers, underscore only" },
      { status: 400 }
    );
  }

  if (!isValidPassword(password)) {
    return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
  }

  const db = getDb();

  const { data: existing } = await db
    .from("app_users")
    .select("id")
    .eq("username", normalizedUsername)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ error: "Username already taken" }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);

  const { data: user, error } = await db
    .from("app_users")
    .insert({
      username: normalizedUsername,
      password_hash: passwordHash,
      display_name: displayName?.trim() || normalizedUsername,
    })
    .select("id, username")
    .single();

  if (error || !user) {
    return NextResponse.json({ error: error?.message ?? "Failed to create account" }, { status: 400 });
  }

  const token = await signSession({ userId: user.id, username: user.username });
  const response = NextResponse.json({ ok: true });
  const opts = sessionCookieOptions(token);
  response.cookies.set(opts.name, opts.value, opts);
  return response;
}
