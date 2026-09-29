import { z } from "zod";
import { LanguageHint } from "../languages";
import type { StructuredNote } from "./note";

export const NoteKind = z.enum(["meeting", "memo", "call", "file", "chat_export"]);
export type NoteKind = z.infer<typeof NoteKind>;

export const NoteStatus = z.enum([
  "queued",
  "uploading",
  "transcribing",
  "extracting",
  "summarising",
  "embedding",
  "waiting_quota",
  "done",
  "failed",
]);
export type NoteStatus = z.infer<typeof NoteStatus>;

/** Statuses where the server is still working (the app keeps refreshing). */
export const IN_PROGRESS: NoteStatus[] = ["queued", "uploading", "transcribing", "extracting", "summarising", "embedding", "waiting_quota"];

// ───────────── requests ─────────────

export const CreateRecordingNoteBody = z.object({
  kind: z.enum(["meeting", "memo", "call"]),
  /** Device-generated id so a retried request never creates a duplicate note. */
  local_id: z.string().min(8).max(64),
  language_hint: LanguageHint.default("auto"),
  project_id: z.uuid().nullable().optional(),
  started_at: z.iso.datetime(),
  duration_sec: z.number().int().nonnegative().nullable().optional(),
  mime: z.string().default("audio/mp4"),
  size_bytes: z.number().int().positive(),
  extension: z.string().regex(/^\.[a-z0-9]{2,5}$/).default(".m4a"),
});
export type CreateRecordingNoteBody = z.infer<typeof CreateRecordingNoteBody>;

export const CreateTextMemoBody = z.object({
  local_id: z.string().min(8).max(64),
  text: z.string().min(1).max(50_000),
  project_id: z.uuid().nullable().optional(),
  started_at: z.iso.datetime().optional(),
});
export type CreateTextMemoBody = z.infer<typeof CreateTextMemoBody>;

export const CreateFileBody = z.object({
  local_id: z.string().min(8).max(64),
  file_name: z.string().min(1).max(255),
  mime: z.string().max(120).nullable().optional(),
  size_bytes: z.number().int().positive().max(100 * 1024 * 1024),
  project_id: z.uuid().nullable().optional(),
  /** Attach to an existing meeting/note. */
  related_note_id: z.uuid().nullable().optional(),
  /** Used when the file is audio (voice note). */
  language_hint: LanguageHint.default("auto"),
});
export type CreateFileBody = z.infer<typeof CreateFileBody>;

export const UpdateNoteBody = z.object({
  title: z.string().min(1).max(200).optional(),
  summary: z.string().max(5000).optional(),
  project_id: z.uuid().nullable().optional(),
  related_note_id: z.uuid().nullable().optional(),
});
export type UpdateNoteBody = z.infer<typeof UpdateNoteBody>;

export const UpdateSegmentBody = z.object({
  text: z.string().min(1).max(10_000).optional(),
  speaker_label: z.string().min(1).max(80).nullable().optional(),
});
export type UpdateSegmentBody = z.infer<typeof UpdateSegmentBody>;

export const RenameSpeakerBody = z.object({
  from: z.string().min(1).max(80),
  to: z.string().min(1).max(80),
});

export const UpdateTaskBody = z.object({
  status: z.enum(["open", "done", "cancelled"]).optional(),
  title: z.string().min(1).max(500).optional(),
  due_date: z.iso.date().nullable().optional(),
});

export const CreateProjectBody = z.object({
  name: z.string().min(1).max(120),
  code: z.string().max(40).nullable().optional(),
  location: z.string().max(200).nullable().optional(),
});

// ───────────── responses ─────────────

export interface CreateRecordingNoteResponse {
  note_id: string;
  /** Null when the audio was already uploaded (retried request). */
  upload: { url: string; content_type: string } | null;
}

export interface CreateFileResponse {
  note_id: string;
  file_id: string;
  /** Null when the file was already uploaded (retried request). */
  upload: { url: string; content_type: string } | null;
}

export interface FileDto {
  id: string;
  original_name: string;
  mime: string | null;
  size_bytes: number | null;
  file_kind: string | null;
  page_count: number | null;
}

/** A short reference to another note (linked meeting / attached files). */
export interface NoteRef {
  id: string;
  kind: NoteKind;
  title: string | null;
  status: NoteStatus;
  started_at: string | null;
}

export interface NoteListItem {
  id: string;
  kind: NoteKind;
  title: string | null;
  status: NoteStatus;
  progress_text: string | null;
  error_message: string | null;
  started_at: string | null;
  duration_sec: number | null;
  project_id: string | null;
  project_name: string | null;
  summary: string | null;
  open_tasks: number;
}

export interface TranscriptSegmentDto {
  id: string;
  idx: number;
  speaker_label: string | null;
  text: string;
  gloss: string | null;
  start_ms: number | null;
  edited: boolean;
}

export interface TaskDto {
  id: string;
  title: string;
  owner_text: string | null;
  due_date: string | null;
  priority: "high" | "medium" | "low";
  status: "open" | "done" | "cancelled";
}

export interface FigureDto {
  id: string;
  kind: string;
  value: number | null;
  unit: string | null;
  currency: string | null;
  item: string | null;
  vendor_text: string | null;
  reference_no: string | null;
  raw_text: string;
}

export interface FollowUpDto {
  id: string;
  type: "meeting" | "call" | "deadline" | "reminder";
  description: string;
  suggested_start: string | null;
  status: "pending" | "accepted" | "dismissed";
}

export interface NoteDetail extends NoteListItem {
  error_hint: string | null;
  language_hint: string;
  languages_detected: string[];
  location: string | null;
  structured: StructuredNote | null;
  user_edited: boolean;
  has_audio: boolean;
  segments: TranscriptSegmentDto[];
  tasks: TaskDto[];
  figures: FigureDto[];
  follow_ups: FollowUpDto[];
  /** Original files behind this note (shared/uploaded). */
  files: FileDto[];
  /** The meeting this note is attached to, if any. */
  related_note: NoteRef | null;
  /** Files/notes attached to this meeting. */
  attachments: NoteRef[];
}

export interface ProjectDto {
  id: string;
  name: string;
  code: string | null;
  location: string | null;
  status: "active" | "closed";
}
