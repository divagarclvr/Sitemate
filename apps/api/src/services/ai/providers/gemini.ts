import { ApiError, GoogleGenAI, type Content } from "@google/genai";
import {
  ProviderUnavailableError,
  QuotaExceededError,
  type GenerateOptions,
  type LlmMessage,
  type LlmProvider,
  type LlmResult,
} from "../types";

/**
 * Google Gemini (free tier). Each tier takes a list of models tried in order: free models
 * are often overloaded (503) and free limits are counted per model, so when one model is
 * busy or used up, the next one is tried before giving up.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  private client: GoogleGenAI;

  constructor(
    apiKey: string,
    private mainModels: string[],
    private liteModels: string[],
  ) {
    if (mainModels.length === 0 || liteModels.length === 0) throw new Error("GEMINI_MODEL(_LITE) is empty");
    this.client = new GoogleGenAI({
      apiKey,
      // Fail fast when a model is overloaded so the next model takes over at once,
      // instead of the SDK default of 5 attempts with up to 60 s waits between them.
      httpOptions: { timeout: 90_000, retryOptions: { attempts: 1 } },
    });
  }

  modelFor(tier: GenerateOptions["tier"] = "main") {
    return this.modelsFor(tier)[0]!;
  }

  private modelsFor(tier: GenerateOptions["tier"] = "main") {
    return tier === "lite" ? this.liteModels : this.mainModels;
  }

  async generate(messages: LlmMessage[], opts: GenerateOptions = {}): Promise<LlmResult> {
    const contents: Content[] = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: m.parts.map((p) =>
        p.type === "text"
          ? { text: p.text }
          : { inlineData: { mimeType: p.mimeType, data: p.dataBase64 } },
      ),
    }));

    const models = this.modelsFor(opts.tier);
    let lastError: ProviderUnavailableError | null = null;

    for (const model of models) {
      try {
        const res = await this.client.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: opts.system,
            maxOutputTokens: opts.maxOutputTokens,
            temperature: opts.temperature,
            ...(opts.jsonSchema
              ? { responseMimeType: "application/json", responseJsonSchema: opts.jsonSchema }
              : {}),
          },
        });
        return {
          text: res.text ?? "",
          provider: this.name,
          model,
          inputTokens: res.usageMetadata?.promptTokenCount ?? null,
          outputTokens: res.usageMetadata?.candidatesTokenCount ?? null,
        };
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) {
          lastError = new QuotaExceededError(this.name, `Gemini free-tier limit reached (${models.join(", ")})`);
        } else if ((err instanceof ApiError && err.status >= 500) || isTimeout(err)) {
          lastError = new ProviderUnavailableError(this.name, `Gemini is busy right now (${models.join(", ")})`);
        } else {
          throw err;
        }
      }
    }
    throw lastError!;
  }
}

function isTimeout(err: unknown) {
  const name = (err as { name?: string } | null)?.name ?? "";
  return name === "AbortError" || name === "TimeoutError";
}
