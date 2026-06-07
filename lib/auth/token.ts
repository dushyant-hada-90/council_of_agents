import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "coa_session";
export const GUEST_SESSION_COOKIE = "coa_guest_session";

export interface SessionPayload {
  userId: string;
  username: string;
}

export interface GuestTokenPayload {
  type: "guest";
  meetingId: string;
  guestSessionId: string;
}

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SECRET must be set and at least 32 characters");
  }
  return new TextEncoder().encode(secret);
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ userId: payload.userId, username: payload.username })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.type === "guest") return null;
    const userId = payload.userId;
    const username = payload.username;
    if (typeof userId !== "string" || typeof username !== "string") return null;
    return { userId, username };
  } catch {
    return null;
  }
}

export async function signGuestToken(payload: Omit<GuestTokenPayload, "type">): Promise<string> {
  return new SignJWT({
    type: "guest",
    meetingId: payload.meetingId,
    guestSessionId: payload.guestSessionId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(getSecret());
}

export async function verifyGuestToken(token: string): Promise<GuestTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.type !== "guest") return null;
    const meetingId = payload.meetingId;
    const guestSessionId = payload.guestSessionId;
    if (typeof meetingId !== "string" || typeof guestSessionId !== "string") return null;
    return { type: "guest", meetingId, guestSessionId };
  } catch {
    return null;
  }
}

export function sessionCookieOptions(token: string) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  };
}

export function guestSessionCookieOptions(guestSessionId: string) {
  return {
    name: GUEST_SESSION_COOKIE,
    value: guestSessionId,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  };
}
