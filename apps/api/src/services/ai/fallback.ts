import {
  ProviderUnavailableError,
  UnsupportedInputError,
  type GenerateOptions,
  type LlmMessage,
  type LlmProvider,
  type LlmResult,
} from "./types";

/** Uses `main`; if its free quota is used up or it is overloaded, tries `fallback`. */
export class FallbackProvider implements LlmProvider {
  readonly name: string;

  constructor(
    private main: LlmProvider,
    private fallback: LlmProvider | null,
  ) {
    this.name = main.name;
  }

  modelFor(tier?: GenerateOptions["tier"]) {
    return this.main.modelFor(tier);
  }

  async generate(messages: LlmMessage[], opts?: GenerateOptions): Promise<LlmResult> {
    try {
      return await this.main.generate(messages, opts);
    } catch (err) {
      if (!(err instanceof ProviderUnavailableError) || !this.fallback) throw err;
      try {
        return await this.fallback.generate(messages, opts);
      } catch (fbErr) {
        // Images/PDFs can't go to a text-only fallback: report the original problem.
        if (fbErr instanceof UnsupportedInputError) throw err;
        throw fbErr;
      }
    }
  }
}
