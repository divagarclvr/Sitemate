import Groq, { toFile } from "groq-sdk";
import type { LanguageHint } from "@sitemate/shared";
import { ProviderUnavailableError, QuotaExceededError } from "../ai/types";
import type { SttProvider, SttResult } from "./types";

/** Words Whisper often mishears on Indian construction sites; passed as a spelling hint. */
const VOCABULARY_HINT =
  "Construction site meeting in Bengaluru. Terms: TMT, Fe550D, RMC, M25, M30, shuttering, " +
  "centering, BBS, M-book, RA bill, WBS, PO, work order, sqft, cum, MT, rmt, nos, lakh, crore, " +
  "GST, slab, column, footing, plinth, plastering, waterproofing, MEP, BOQ, estimate.";

interface VerboseSegment {
  start: number;
  end: number;
  text: string;
}

export class GroqWhisper implements SttProvider {
  readonly name = "groq";
  private client: Groq;

  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new Groq({ apiKey, maxRetries: 1, timeout: 10 * 60_000 });
  }

  async transcribe(audio: Buffer, filename: string, language: LanguageHint): Promise<SttResult> {
    try {
      const res = (await this.client.audio.transcriptions.create({
        file: await toFile(audio, filename),
        model: this.model,
        ...(language !== "auto" ? { language } : {}),
        prompt: VOCABULARY_HINT,
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
        temperature: 0,
      })) as unknown as { text: string; language?: string; duration?: number; segments?: VerboseSegment[] };

      const segments = (res.segments ?? []).map((s) => ({
        startMs: Math.round(s.start * 1000),
        endMs: Math.round(s.end * 1000),
        text: s.text.trim(),
      }));
      return {
        text: res.text.trim(),
        segments: segments.filter((s) => s.text),
        language: res.language ?? null,
        durationSec: Math.round(res.duration ?? (segments.at(-1)?.endMs ?? 0) / 1000),
        model: this.model,
        provider: this.name,
      };
    } catch (err) {
      if (err instanceof Groq.RateLimitError) {
        throw new QuotaExceededError(this.name, "Groq free transcription limit reached");
      }
      if (err instanceof Groq.InternalServerError || err instanceof Groq.APIConnectionError) {
        throw new ProviderUnavailableError(this.name, "Groq transcription is busy or unreachable");
      }
      throw err;
    }
  }
}
