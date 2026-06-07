import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  GCP_PROJECT_ID: z.string().min(1, "GCP_PROJECT_ID is required"),
  GOOGLE_APPLICATION_CREDENTIALS: z
    .string()
    .min(1, "GOOGLE_APPLICATION_CREDENTIALS is required (path to GCP service account JSON)"),
  GEMINI_PLANNER_MODEL: z.string().default("gemini-2.0-flash"),
  GEMINI_CHAT_MODEL: z.string().default("gemini-2.0-flash"),
  GEMINI_ROUTING_MODEL: z.string().default("gemini-2.0-flash"),
  GEMINI_ROUTING_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  GEMINI_MERGED_TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
  AWS_REGION: z.string().min(1, "AWS_REGION is required"),
  AWS_ACCESS_KEY_ID: z.string().min(1, "AWS_ACCESS_KEY_ID is required"),
  AWS_SECRET_ACCESS_KEY: z.string().min(1, "AWS_SECRET_ACCESS_KEY is required"),
  S3_BUCKET_NAME: z.string().min(1, "S3_BUCKET_NAME is required"),
  GUEST_AUDIO_WARN_SECONDS: z.coerce.number().int().positive().default(480),
  GUEST_AUDIO_MAX_SECONDS: z.coerce.number().int().positive().default(600),
  LOG_LEVEL: z.enum(["minimal", "verbose", "info", "debug"]).default("minimal"),
  HUMAN_STT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  TRANSCRIPT_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  SESSION_RECORDINGS_DIR: z.string().optional(),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  MEETING_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(240000),
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
