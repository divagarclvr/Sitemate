import type { LanguageHint } from "@sitemate/shared";

export interface SttSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface SttResult {
  text: string;
  segments: SttSegment[];
  /** Language the engine detected (ISO code or name, as the provider reports it). */
  language: string | null;
  durationSec: number;
  model: string;
  provider: string;
}

export interface SttProvider {
  readonly name: string;
  transcribe(audio: Buffer, filename: string, language: LanguageHint): Promise<SttResult>;
}
