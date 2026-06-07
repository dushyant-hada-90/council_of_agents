import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime-2"),
  OPENAI_TRANSCRIPTION_MODEL: z.string().default("gpt-4o-mini-transcribe"),
  GROQ_API_KEY: z.string().optional(),
  GROQ_ROUTING_MODEL: z.string().default("meta-llama/llama-4-scout-17b-16e-instruct"),
  GROQ_ROUTING_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  HUMAN_REALTIME_TRANSCRIPT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  LOG_LEVEL: z.enum(["minimal", "verbose", "info", "debug"]).default("minimal"),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  TRANSCRIPT_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  /** End meeting after this much silence (no audio/transcript activity). Default 4 minutes. */
  MEETING_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(240000),
  SESSION_RECORDINGS_DIR: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Environment validation failed:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function getEnvSafe(): Env | null {
  try {
    return getEnv();
  } catch {
    return null;
  }
}
