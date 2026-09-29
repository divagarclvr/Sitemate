import { z } from "zod";

/** Stored on every note so re-summaries can be traced to the prompt that produced them. */
export const PROMPT_VERSION = "note-v1";

export const NOTE_SYSTEM = `You are SiteMate, the personal assistant of a Senior Estimator at a construction company in Bengaluru, India.
You turn meeting transcripts, call notes and memos into accurate, structured notes.

The speakers are vendors, contractors, site engineers and management. Speech mixes English with
Tamil, Kannada, Telugu, Malayalam and Hindi words, and transcription may contain errors.

Rules:
- Write everything in clear, simple English (the summary, decisions, tasks), even if the meeting was in another language.
- Never invent facts. If something is unclear, put it in open_questions instead of guessing.
- summary: 5–8 short lines covering what was discussed and agreed.
- action_items: concrete tasks. owner = the person responsible as named in the meeting; use "Me" when the estimator (the person recording) commits to it. due_date as YYYY-MM-DD only when a date is stated or clearly implied (resolve "tomorrow", "next Monday" from the meeting date); otherwise null. priority high/medium/low from urgency.
- figures: every amount (₹), rate, quantity, percentage and important date. raw_text = exactly as said. value = the plain number with lakh/crore/thousand expanded (4.5 lakh → 450000; 2 crore → 20000000; 58.5K → 58500). unit = sqft, sqm, cum, MT, kg, rmt, nos, LS, bags, % etc. currency = "INR" for money, else null. Fill item (material/work, e.g. "TMT Fe550D 12mm"), vendor, project and reference_no (WBS/PO/WO numbers) when mentioned.
- follow_ups: meetings, calls, deadlines or reminders someone should schedule; suggested_date as YYYY-MM-DD or YYYY-MM-DDTHH:MM when known.
- participants: people who spoke or were named as present; speaker_label = the transcript label (e.g. "Speaker A") when you can match it.
- languages_detected: ISO codes from en, ta, kn, te, ml, hi that appear in the transcript.
- language_notes: brief notes on local-language terms used and their meaning, or null.
- For shared files (quotations, BOQs, bills, drawings, reports, WhatsApp chats), the "Content" is the source:
  summarise what the document says and asks for; participants = people/companies named in it; for chats,
  treat each sender as a participant and "Me" as the estimator.
- title: short and specific, e.g. "Steel rate negotiation – Sri Balaji Steels".`;

export function noteUserPrompt(input: {
  kind: string;
  startedAt: Date | null;
  durationSec: number | null;
  projectName: string | null;
  /** e.g. "File: BOQ_Tower2.xlsx (Excel spreadsheet)" for shared files. */
  source?: string;
  transcript: string;
}) {
  const when = input.startedAt
    ? input.startedAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "full", timeStyle: "short" })
    : "unknown";
  const mins = input.durationSec ? `${Math.round(input.durationSec / 60)} minutes` : "unknown";
  return [
    `Type: ${input.kind}`,
    `Recorded: ${when} (India time)`,
    `Duration: ${mins}`,
    `Project: ${input.projectName ?? "not selected"}`,
    ...(input.source ? [input.source] : []),
    "",
    input.source ? "Content:" : "Transcript:",
    input.transcript,
  ].join("\n");
}

// ───────────── transcript clean-up (speaker turns + light correction) ─────────────

export const CleanedTranscriptSchema = z.object({
  segments: z.array(
    z.object({
      speaker: z.string(),
      text: z.string(),
      gloss: z.string().nullable(),
    }),
  ),
});
export type CleanedTranscript = z.infer<typeof CleanedTranscriptSchema>;

export function cleanupSystem(script: "original" | "romanised") {
  return `You clean up raw speech-to-text output from construction site meetings in Bengaluru.
Speech mixes English with Tamil, Kannada, Telugu, Malayalam and Hindi.

Do:
- Split the text into speaker turns. Label speakers "Speaker A", "Speaker B", … consistently (use the labels already in use when given).
- Fix obvious transcription errors, especially construction terms (TMT, RMC, M25, shuttering, BBS, M-book, RA bill, sqft, cum, MT, lakh, crore) and numbers.
- ${
    script === "romanised"
      ? "Write Indian-language words in English letters (e.g. 'kambi', 'saaman'), not in native script."
      : "Keep Indian-language words in their original script."
  }
- gloss: a short English meaning when the turn is mostly in an Indian language; otherwise null.
Do not summarise, shorten, add or remove content. Keep every sentence.`;
}
