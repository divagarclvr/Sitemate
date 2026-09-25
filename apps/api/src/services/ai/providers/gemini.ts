import { ApiError, GoogleGenAI, type Content } from "@google/genai";
import {
  ProviderUnavailableError,
  QuotaExceededError,
  type GenerateOptions,
  type LlmMessage,
  type LlmProvider,
  type LlmResult,
} from "../types";

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  private client: GoogleGenAI;

  constructor(
    apiKey: string,
    private mainModel: string,
    private liteModel: string,
  ) {
    this.client = new GoogleGenAI({
      apiKey,
      // Fail fast when Google is overloaded so the backup AI takes over at once,
      // instead of the SDK default of 5 attempts with up to 60 s waits between them.
      httpOptions: { timeout: 90_000, retryOptions: { attempts: 1 } },
    });
  }

  modelFor(tier: GenerateOptions["tier"] = "main") {
    return tier === "lite" ? this.liteModel : this.mainModel;
  }

  async generate(messages: LlmMessage[], opts: GenerateOptions = {}): Promise<LlmResult> {
    const model = this.modelFor(opts.tier);
    const contents: Content[] = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: m.parts.map((p) =>
        p.type === "text"
          ? { text: p.text }
          : { inlineData: { mimeType: p.mimeType, data: p.dataBase64 } },
      ),
    }));

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
        throw new QuotaExceededError(this.name, `Gemini free-tier limit reached for ${model}`);
      }
      if ((err instanceof ApiError && err.status >= 500) || isTimeout(err)) {
        throw new ProviderUnavailableError(this.name, `Gemini is busy or not responding (${model})`);
      }
      throw err;
    }
  }
}

function isTimeout(err: unknown) {
  const name = (err as { name?: string } | null)?.name ?? "";
  return name === "AbortError" || name === "TimeoutError";
}
