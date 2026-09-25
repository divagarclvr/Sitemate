import { loadEnv } from "../src/config/env";
import type { GenerateOptions, LlmMessage, LlmProvider, LlmResult } from "../src/services/ai/types";

export const testEnv = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://unused",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "test",
  WORKER_ENABLED: "false",
  ALLOWED_EMAILS: "Owner@Example.com",
  GEMINI_API_KEY: "test",
});

/** Fake AI that replays scripted replies (strings) or throws scripted errors. */
export class ScriptedProvider implements LlmProvider {
  calls: { messages: LlmMessage[]; opts?: GenerateOptions }[] = [];
  constructor(
    public readonly name: string,
    private script: (string | Error)[],
  ) {}
  modelFor() {
    return `${this.name}-model`;
  }
  async generate(messages: LlmMessage[], opts?: GenerateOptions): Promise<LlmResult> {
    this.calls.push({ messages, opts });
    const next = this.script.shift();
    if (next === undefined) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return { text: next, provider: this.name, model: this.modelFor(), inputTokens: 10, outputTokens: 5 };
  }
}

export const userMsg = (text: string): LlmMessage[] => [{ role: "user", parts: [{ type: "text", text }] }];
