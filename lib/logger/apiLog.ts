import { logger } from "./core";

export type GoogleApiService = "STT" | "TTS" | "GEMINI";

/** Log an outbound Google API call. Returns a timer handle for `logApiResponse`. */
export function logApiRequest(
  service: GoogleApiService,
  operation: string,
  detail: string
): number {
  logger.api(service, `→ REQ ${operation} | ${detail}`);
  return performance.now();
}

/** Log a completed Google API response with elapsed ms. */
export function logApiResponse(
  service: GoogleApiService,
  startedAt: number,
  operation: string,
  detail: string
): void {
  const ms = Math.round(performance.now() - startedAt);
  logger.api(service, `← RES ${operation} | ${ms}ms | ${detail}`);
}

/** Log a failed Google API response with elapsed ms. */
export function logApiError(
  service: GoogleApiService,
  startedAt: number,
  operation: string,
  detail: string
): void {
  const ms = Math.round(performance.now() - startedAt);
  logger.apiError(service, `← ERR ${operation} | ${ms}ms | ${detail}`);
}

export function previewText(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "(empty)";
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}
