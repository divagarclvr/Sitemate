import Groq from "groq-sdk";
import {
  QuotaExceededError,
  UnsupportedInputError,
  type GenerateOptions,
  type LlmMessage,
  type LlmProvider,
  type LlmResult,
} from "../types";

/** Groq free tier: text-only fallback for short jobs (8K tokens/min limit). */
export class GroqProvider implements LlmProvider {
  readonly name = "groq";
  private client: Groq;

  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new Groq({ apiKey });
  }

  modelFor() {
    return this.model;
  }

  async generate(messages: LlmMessage[], opts: GenerateOptions = {}): Promise<LlmResult> {
    const chat: Groq.Chat.ChatCompletionMessageParam[] = [];
    let system = opts.system ?? "";
    if (opts.jsonSchema) {
      system += `\n\nReply with ONLY a JSON object matching this JSON Schema:\n${JSON.stringify(opts.jsonSchema)}`;
    }
    if (system.trim()) chat.push({ role: "system", content: system.trim() });

    for (const m of messages) {
      const text = m.parts
        .map((p) => {
          if (p.type !== "text") {
            throw new UnsupportedInputError("The Groq fallback cannot read images, PDFs or audio");
          }
          return p.text;
        })
        .join("\n");
      chat.push({ role: m.role, content: text });
    }

    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: chat,
        max_completion_tokens: opts.maxOutputTokens,
        temperature: opts.temperature,
        ...(opts.jsonSchema ? { response_format: { type: "json_object" as const } } : {}),
      });
      return {
        text: res.choices[0]?.message?.content ?? "",
        provider: this.name,
        model: this.model,
        inputTokens: res.usage?.prompt_tokens ?? null,
        outputTokens: res.usage?.completion_tokens ?? null,
      };
    } catch (err) {
      if (err instanceof Groq.RateLimitError) {
        throw new QuotaExceededError(this.name, `Groq free-tier limit reached for ${this.model}`);
      }
      throw err;
    }
  }
}
