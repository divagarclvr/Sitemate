import { z } from "zod";

/** Languages SiteMate understands. Transcripts keep original words; summaries are English. */
export const LANGUAGES = [
  { code: "en", name: "English", native: "English" },
  { code: "ta", name: "Tamil", native: "தமிழ்" },
  { code: "kn", name: "Kannada", native: "ಕನ್ನಡ" },
  { code: "te", name: "Telugu", native: "తెలుగు" },
  { code: "ml", name: "Malayalam", native: "മലയാളം" },
  { code: "hi", name: "Hindi", native: "हिन्दी" },
] as const;

export const LanguageCode = z.enum(["en", "ta", "kn", "te", "ml", "hi"]);
export type LanguageCode = z.infer<typeof LanguageCode>;

/** "auto" lets the speech-to-text engine guess; a fixed hint is more accurate for mixed speech. */
export const LanguageHint = z.enum(["auto", "en", "ta", "kn", "te", "ml", "hi"]);
export type LanguageHint = z.infer<typeof LanguageHint>;
