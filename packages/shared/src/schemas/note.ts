import { z } from "zod";
import { LanguageCode } from "../languages";

const nullableString = z.string().nullable();

export const Participant = z.object({
  name: z.string(),
  role: nullableString,
  company: nullableString,
  speaker_label: nullableString,
  contact_id: nullableString,
});

export const ActionItem = z.object({
  task: z.string(),
  owner: nullableString,
  due_date: nullableString, // ISO date (YYYY-MM-DD) when known
  priority: z.enum(["high", "medium", "low"]),
  source_quote: nullableString,
});

export const Figure = z.object({
  kind: z.enum(["amount", "quantity", "rate", "percentage", "date", "other"]),
  value: z.number().nullable(), // normalised: "4.5 L" -> 450000
  raw_text: z.string(), // as spoken: "₹ 4,850 per MT"
  unit: nullableString, // sqft, cum, MT, nos …
  currency: z.literal("INR").nullable(),
  item: nullableString,
  vendor: nullableString,
  project: nullableString,
  reference_no: nullableString, // WBS / PO / WO number
});

export const FollowUp = z.object({
  description: z.string(),
  suggested_date: nullableString,
  type: z.enum(["meeting", "call", "deadline", "reminder"]),
});

export const StructuredNoteSchema = z.object({
  title: z.string().min(1),
  meeting_date: nullableString,
  location: nullableString,
  participants: z.array(Participant),
  summary: z.string().min(1),
  key_decisions: z.array(z.string()),
  action_items: z.array(ActionItem),
  figures: z.array(Figure),
  vendors_contractors: z.array(z.string()),
  projects_mentioned: z.array(z.string()),
  follow_ups: z.array(FollowUp),
  open_questions: z.array(z.string()),
  languages_detected: z.array(LanguageCode),
  language_notes: nullableString,
});

export type StructuredNote = z.infer<typeof StructuredNoteSchema>;
