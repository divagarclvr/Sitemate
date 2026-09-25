import type { Env } from "../../config/env";
import { FallbackProvider } from "./fallback";
import { GeminiProvider } from "./providers/gemini";
import { GroqProvider } from "./providers/groq";
import type { LlmProvider } from "./types";

export interface AiProviders {
  /** Use this everywhere: main provider with automatic free-quota fallback. */
  llm: LlmProvider;
  main: LlmProvider | null;
  fallback: LlmProvider | null;
}

export function createAiProviders(env: Env): AiProviders {
  const main = env.GEMINI_API_KEY
    ? new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL, env.GEMINI_MODEL_LITE)
    : null;
  const fallback =
    env.AI_FALLBACK_PROVIDER === "groq" && env.GROQ_API_KEY
      ? new GroqProvider(env.GROQ_API_KEY, env.GROQ_LLM_MODEL)
      : null;

  const primary = main ?? fallback;
  if (!primary) {
    throw new Error("No AI key set. Put GEMINI_API_KEY (and GROQ_API_KEY) in apps/api/.env");
  }
  return { llm: new FallbackProvider(primary, main ? fallback : null), main, fallback };
}

export * from "./types";
