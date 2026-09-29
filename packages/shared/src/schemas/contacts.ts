import { z } from "zod";
import { LanguageHint } from "../languages";
import type { NoteKind, NoteStatus } from "./notes";

const phone = z.string().trim().min(3).max(30);

export const ContactInput = z.object({
  name: z.string().trim().min(1).max(120),
  company: z.string().trim().max(120).nullable().optional(),
  role: z.string().trim().max(120).nullable().optional(),
  phones: z.array(phone).max(10).default([]),
  email: z.string().trim().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  /** Other names people use: "Ramesh Steel", "Balaji Ramesh". */
  name_aliases: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  project_ids: z.array(z.uuid()).max(50).default([]),
});
export type ContactInput = z.infer<typeof ContactInput>;

export const UpdateContactBody = ContactInput.partial();

export const ImportContactsBody = z.object({
  contacts: z
    .array(
      z.object({
        device_contact_id: z.string().min(1).max(100),
        name: z.string().trim().min(1).max(120),
        company: z.string().trim().max(120).nullable().optional(),
        role: z.string().trim().max(120).nullable().optional(),
        phones: z.array(phone).max(10).default([]),
      }),
    )
    .max(2000),
});
export type ImportContactsBody = z.infer<typeof ImportContactsBody>;

export const ResolveContactBody = z.object({
  /** e.g. "Call Ramesh from the steel vendor" */
  utterance: z.string().trim().min(1).max(500),
});

export const TranscribeBody = z.object({
  audio_base64: z.string().min(10).max(3_000_000), // ≈ 2 MB of audio — a short voice command
  mime: z.string().max(60).default("audio/mp4"),
  language_hint: LanguageHint.default("auto"),
});

export interface ContactDto {
  id: string;
  name: string;
  company: string | null;
  role: string | null;
  phones: string[];
  email: string | null;
  notes: string | null;
  name_aliases: string[];
  source: "phone" | "manual";
  project_ids: string[];
  project_names: string[];
}

export interface ContactCandidate {
  contact: ContactDto;
  confidence: number; // 0..1
  reason: string;
}

export interface ResolveContactResponse {
  query: string;
  candidates: ContactCandidate[];
}

export interface ContactDetail extends ContactDto {
  notes_list: { id: string; kind: NoteKind; title: string | null; status: NoteStatus; started_at: string | null }[];
  open_tasks: { id: string; title: string; due_date: string | null; note_id: string | null }[];
}
