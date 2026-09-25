export type LlmPart =
  | { type: "text"; text: string }
  /** Images, PDFs or audio sent inline (base64). */
  | { type: "inline"; mimeType: string; dataBase64: string };

export interface LlmMessage {
  role: "user" | "assistant";
  parts: LlmPart[];
}

export interface GenerateOptions {
  system?: string;
  /** "lite" = faster model with a bigger free quota, for simple jobs (clean-up, matching). */
  tier?: "main" | "lite";
  maxOutputTokens?: number;
  /** When set, the provider is asked to reply with JSON matching this JSON Schema. */
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
}

export interface LlmResult {
  text: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LlmProvider {
  readonly name: string;
  modelFor(tier?: GenerateOptions["tier"]): string;
  generate(messages: LlmMessage[], opts?: GenerateOptions): Promise<LlmResult>;
}

/** A temporary problem on the provider's side. Callers may fall back or re-queue. */
export class ProviderUnavailableError extends Error {
  constructor(
    public provider: string,
    message: string,
  ) {
    super(message);
  }
}

/** Thrown when a free-tier limit is hit (HTTP 429). */
export class QuotaExceededError extends ProviderUnavailableError {}

/** Thrown when a provider can't handle the input at all (e.g. images on a text-only model). */
export class UnsupportedInputError extends Error {}
