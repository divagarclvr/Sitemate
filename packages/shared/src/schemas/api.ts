import { z } from "zod";

/** Every error the API returns has this shape; `hint` is written for the user. */
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    hint: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const ProviderCheck = z.object({
  provider: z.string(),
  model: z.string(),
  ok: z.boolean(),
  reply: z.string().nullable(),
  latency_ms: z.number(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  error: z.string().nullable(),
});
export type ProviderCheck = z.infer<typeof ProviderCheck>;

export const AiDiagnostics = z.object({
  main: ProviderCheck,
  fallback: ProviderCheck.nullable(),
});
export type AiDiagnostics = z.infer<typeof AiDiagnostics>;

export const Me = z.object({
  id: z.string(),
  email: z.string(),
  settings: z.object({
    timezone: z.string(),
    default_language: z.string(),
    transcript_script: z.enum(["original", "romanised"]),
    morning_plan_time: z.string(),
    evening_recap_time: z.string(),
    evening_recap_enabled: z.boolean(),
    audio_retention_days: z.number().nullable(),
    theme: z.enum(["system", "light", "dark", "sunlight"]),
  }),
});
export type Me = z.infer<typeof Me>;
