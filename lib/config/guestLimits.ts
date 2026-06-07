/** Tunable guest audio limits — override via env without code changes. */
export const GUEST_LIMITS = {
  audioWarnSeconds: Number(process.env.GUEST_AUDIO_WARN_SECONDS ?? 480),
  audioMaxSeconds: Number(process.env.GUEST_AUDIO_MAX_SECONDS ?? 600),
} as const;
