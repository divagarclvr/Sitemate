import Groq, { toFile } from "groq-sdk";
import type { LanguageHint } from "@sitemate/shared";
import { ProviderUnavailableError, QuotaExceededError } from "../ai/types";
import type { SttProvider, SttResult } from "./types";

/** Words Whisper often mishears on Indian construction sites; passed as a spelling hint. */
const VOCABULARY_HINT =
  "Construction site meeting in Bengaluru. Terms: TMT, Fe550D, RMC, M25, M30, shuttering, " +
  "centering, BBS, M-book, RA bill, WBS, PO, work order, sqft, cum, MT, rmt, nos, lakh, crore, " +
  "GST, slab, column, footing, plinth, plastering, waterproofing, MEP, BOQ, estimate.";

export interface VerboseSegment {
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
}

/**
 * Whisper invents text over silence or noise ("Tmk.com, Tmk.com…", "Thank you for watching").
 * Its own confidence scores show which segments to drop. Exported for tests.
 */
export function isLikelyHallucination(s: VerboseSegment): boolean {
  const text = s.text.trim();
  if (!text || /^[\s.,!?…-]*$/.test(text)) return true;
  if ((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -0.7) return true;
  if ((s.compression_ratio ?? 0) > 2.4) return true; // highly repetitive
  if ((s.avg_logprob ?? 0) < -1.2) return true; // very unsure
  // Same short phrase repeated 3+ times ("Tmk.com, Tmk.com, Tmk.com")
  const parts = text.split(/[,;]\s*|[.!?]\s+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  return parts.length >= 3 && new Set(parts).size === 1;
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

      const all = res.segments ?? [];
      const segments = all
        .filter((s) => !isLikelyHallucination(s))
        .map((s) => ({ startMs: Math.round(s.start * 1000), endMs: Math.round(s.end * 1000), text: s.text.trim() }));
      return {
        // Rebuild the text from trusted segments only (res.text still contains the invented lines).
        text: all.length ? segments.map((s) => s.text).join(" ") : res.text.trim(),
        segments,
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
