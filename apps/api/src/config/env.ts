import { z } from "zod";

const csv = (fallback = "") =>
  z
    .string()
    .default(fallback)
    .transform((s) => s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),
  PUBLIC_BASE_URL: z.string().default("http://localhost:8080"),
  TZ_DEFAULT: z.string().default("Asia/Kolkata"),

  // Database / Supabase
  DATABASE_URL: z
    .string({ error: "missing — copy it from Supabase → Connect → Transaction pooler" })
    .min(1, "missing — copy it from Supabase → Connect → Transaction pooler"),
  SUPABASE_URL: z.url({ error: "missing or wrong — should look like https://xxxx.supabase.co" }),
  // Legacy HS256 secret. Leave empty to verify tokens with Supabase's public JWKS keys instead.
  SUPABASE_JWT_SECRET: z.string().optional().default(""),
  // Server-only key for file storage (Supabase → Project Settings → API Keys → Secret keys).
  SUPABASE_SECRET_KEY: z
    .string({ error: "missing — copy it from Supabase → Project Settings → API Keys → Secret keys" })
    .min(1, "missing — copy it from Supabase → Project Settings → API Keys → Secret keys"),
  STORAGE_BUCKET: z.string().default("sitemate-private"),
  ALLOWED_EMAILS: csv(),

  // Speech-to-text (Groq free tier)
  STT_MODEL: z.string().default("whisper-large-v3"),
  /** Groq's free tier accepts files up to 25 MB; larger recordings are split with ffmpeg. */
  STT_MAX_MB: z.coerce.number().default(24),
  STT_CHUNK_SECONDS: z.coerce.number().default(1200),

  // Background worker
  WORKER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  WORKER_POLL_MS: z.coerce.number().default(5000),

  // AI
  AI_PROVIDER: z.enum(["gemini"]).default("gemini"),
  GEMINI_API_KEY: z.string().default(""),
  // Comma-separated lists, tried in order when a model is busy or its free limit is used up.
  GEMINI_MODEL: csv("gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite"),
  GEMINI_MODEL_LITE: csv("gemini-3.5-flash-lite,gemini-3.6-flash"),
  AI_FALLBACK_PROVIDER: z.enum(["groq", "none"]).default("groq"),
  GROQ_API_KEY: z.string().default(""),
  GROQ_LLM_MODEL: z.string().default("openai/gpt-oss-120b"),

  // Limits
  RATE_LIMIT_PER_MIN: z.coerce.number().default(60),
});

export type Env = z.infer<typeof EnvSchema>;

/** Parses process.env once; prints every missing/invalid variable in plain words. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  • ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Your apps/api/.env file has problems:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
