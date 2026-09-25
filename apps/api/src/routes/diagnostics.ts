import type { FastifyInstance } from "fastify";
import type { AiDiagnostics, ProviderCheck } from "@sitemate/shared";
import type { AiProviders } from "../services/ai";
import type { LlmProvider } from "../services/ai/types";

const TEST_PROMPT =
  "You are SiteMate, an assistant for a construction estimator in Bengaluru. " +
  "Reply in ONE short line: 'SiteMate AI connected' followed by the word 'steel bar' " +
  "written in Tamil, Kannada, Telugu, Malayalam and Hindi, separated by ' / '.";

async function check(provider: LlmProvider): Promise<ProviderCheck> {
  const started = Date.now();
  const model = provider.modelFor("main");
  try {
    const r = await provider.generate([{ role: "user", parts: [{ type: "text", text: TEST_PROMPT }] }], {
      maxOutputTokens: 2000,
    });
    return {
      provider: r.provider,
      model: r.model,
      ok: r.text.trim().length > 0,
      reply: r.text.trim(),
      latency_ms: Date.now() - started,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      error: null,
    };
  } catch (err) {
    return {
      provider: provider.name,
      model,
      ok: false,
      reply: null,
      latency_ms: Date.now() - started,
      input_tokens: null,
      output_tokens: null,
      error: (err as Error).message.slice(0, 500),
    };
  }
}

export function diagnosticsRoutes(ai: AiProviders) {
  return async (app: FastifyInstance) => {
    app.post(
      "/v1/diagnostics/ai",
      { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
      async (): Promise<AiDiagnostics> => {
        // Test each provider directly (not through the fallback) so you see both results.
        const [main, fallback] = await Promise.all([
          ai.main ? check(ai.main) : Promise.resolve(null),
          ai.fallback ? check(ai.fallback) : Promise.resolve(null),
        ]);
        return { main: main ?? fallback!, fallback: main ? fallback : null };
      },
    );
  };
}
