import { randomUUID } from "crypto";
import type { NextRequest } from "next/server";

export function getClientIp(request: NextRequest | Request): string {
  const headers = request.headers;
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}

export function getOrCreateGuestSessionId(existing?: string | null): string {
  return existing?.trim() || randomUUID();
}
