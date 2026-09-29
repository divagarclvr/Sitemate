import { StructuredNoteSchema, type LanguageHint, type StructuredNote } from "@sitemate/shared";
import type { Env } from "../../config/env";
import type { Sql } from "../../db/client";
import { AppError } from "../../errors";
import { generateValidatedJson } from "../ai/json";
import {
  CleanedTranscriptSchema,
  NOTE_SYSTEM,
  PROMPT_VERSION,
  cleanupSystem,
  noteUserPrompt,
} from "../ai/prompts/note";
import { ProviderUnavailableError, type LlmProvider, type LlmResult } from "../ai/types";
import {
  decodeText,
  detectKind,
  extractPdf,
  extractPresentation,
  extractSpreadsheet,
  extractWhatsAppZip,
  extractWord,
  insertVoiceNotes,
  KIND_LABEL,
  type FileKind,
} from "../extract/documents";
import { prepareImage, VISION_PROMPT } from "../extract/images";
import type { FileStorage } from "../storage";
import { cleanAudio, splitAudio, stitchSegments } from "../stt/chunker";
import type { SttProvider, SttSegment } from "../stt/types";
import { normaliseFigures } from "./indianNumbers";

export interface PipelineDeps {
  db: Sql;
  env: Env;
  storage: FileStorage;
  stt: SttProvider;
  llm: LlmProvider;
}

export interface TranscriptLine {
  speaker: string | null;
  text: string;
  gloss: string | null;
  startMs: number | null;
  endMs: number | null;
}

interface NoteRow {
  id: string;
  user_id: string;
  kind: string;
  language_hint: LanguageHint;
  started_at: Date | null;
  duration_sec: number | null;
  project_id: string | null;
  transcript_text: string | null;
  project_name: string | null;
  transcript_script: "original" | "romanised";
}

/** Max characters of transcript sent per clean-up call (keeps replies well inside output limits). */
const CLEANUP_CHARS = 8000;
/** Longest text sent for summarising (~100k tokens — inside free-tier per-minute limits). */
const MAX_SUMMARY_CHARS = 350_000;
/** Gemini accepts inline files up to ~20 MB per request. */
const MAX_INLINE_BYTES = 18 * 1024 * 1024;

export class NotePipeline {
  constructor(private d: PipelineDeps) {}

  // ───────────────────────── entry points (called by the job worker) ─────────────────────────

  /** Audio → transcript → structured note. Resumes from the transcript if it already exists. */
  async processRecording(noteId: string) {
    const note = await this.loadNote(noteId);
    if (!note.transcript_text) {
      const lines = await this.transcribe(note);
      await this.saveTranscript(note, lines);
      note.transcript_text = linesToText(lines);
    }
    await this.summariseAndSave(note, note.transcript_text);
  }

  /** Typed memo → structured note. */
  async processText(noteId: string) {
    const note = await this.loadNote(noteId);
    if (!note.transcript_text?.trim()) {
      throw new AppError(400, "EMPTY_MEMO", "The memo is empty.", "Type or dictate something and save again.");
    }
    await this.saveTranscript(note, [{ speaker: "Me", text: note.transcript_text, gloss: null, startMs: null, endMs: null }]);
    await this.summariseAndSave(note, note.transcript_text);
  }

  /** Re-runs the AI note on the (possibly edited) transcript. */
  async resummarise(noteId: string) {
    const note = await this.loadNote(noteId);
    const rows = await this.d.db<{ speaker_label: string | null; text: string }[]>`
      select speaker_label, text from transcript_segments where note_id = ${noteId} order by idx`;
    const text = rows.length
      ? rows.map((r) => (r.speaker_label ? `${r.speaker_label}: ${r.text}` : r.text)).join("\n")
      : (note.transcript_text ?? "");
    if (!text.trim()) throw new AppError(400, "NO_TRANSCRIPT", "There is no transcript to summarise yet.");
    await this.d.db`update notes set transcript_text = ${text} where id = ${noteId}`;
    await this.summariseAndSave(note, text);
  }

  /** Shared or uploaded file → readable text → structured note. Resumes from saved text on retry. */
  async processFile(noteId: string) {
    const { db, storage } = this.d;
    const note = await this.loadNote(noteId);
    const [file] = await db<{ id: string; original_name: string; mime: string | null; storage_path: string; file_kind: FileKind | null }[]>`
      select id, original_name, mime, storage_path, file_kind from files
      where note_id = ${noteId} and deleted_at is null and upload_status = 'uploaded'
      order by created_at desc limit 1`;
    if (!file) {
      throw new AppError(409, "NO_AUDIO", "The file hasn't finished uploading.", "Keep the app open with internet; it will upload and continue.");
    }
    const describe = (kind: FileKind) => `File: ${file.original_name} (${KIND_LABEL[kind]})`;

    if (note.transcript_text?.trim() && file.file_kind) {
      await this.summariseAndSave(note, note.transcript_text, describe(file.file_kind));
      return;
    }

    await this.setStatus(note.id, "extracting", "Reading the file…");
    const data = await storage.download(file.storage_path);
    const kind = await detectKind(data, file.original_name, file.mime);
    await db`update files set file_kind = ${kind} where id = ${file.id}`;

    let text = "";
    let lines: TranscriptLine[] | null = null;
    let pageCount: number | null = null;
    switch (kind) {
      case "audio":
        lines = await this.transcribeAudio(note, data, file.original_name);
        text = linesToText(lines);
        break;
      case "image": {
        const img = await prepareImage(data);
        text = await this.readWithVision(note, img.mimeType, img.data, "photo");
        break;
      }
      case "pdf": {
        const r = await extractPdf(data);
        pageCount = r.pageCount;
        if (!r.looksScanned) {
          text = r.text;
        } else if (data.length <= MAX_INLINE_BYTES) {
          text = await this.readWithVision(note, "application/pdf", data, "scanned PDF");
        } else {
          throw new AppError(413, "SCAN_TOO_LARGE", "This scanned PDF is too large to read (over 18 MB).", "Share fewer pages, or photos of the important pages.");
        }
        break;
      }
      case "word":
        text = await extractWord(data);
        break;
      case "excel": {
        const r = extractSpreadsheet(data);
        text = r.text + (r.truncated ? "\n\n[Some very long sheets were shortened to their first 3,000 rows.]" : "");
        break;
      }
      case "powerpoint":
        text = await extractPresentation(data);
        break;
      case "text":
        text = decodeText(data);
        break;
      case "whatsapp":
        text = await this.readWhatsApp(note, data, file.original_name);
        break;
      case "video":
        throw new AppError(415, "UNSUPPORTED_FILE", "Videos aren't supported yet.", "Share the audio, or a screenshot of what matters. The original file is saved.");
      default:
        throw new AppError(
          415,
          "UNSUPPORTED_FILE",
          `SiteMate can't read this type of file (${file.original_name}).`,
          "Supported: PDF, Word (.docx), Excel/CSV, PowerPoint (.pptx), photos, audio and WhatsApp chats. The original file is saved.",
        );
    }

    if (!text.trim()) {
      throw new AppError(422, "EMPTY_FILE", "No readable content was found in this file.", "If it's a photo or scan, try a clearer, well-lit image.");
    }
    await db`update files set extracted_text = ${text}, page_count = ${pageCount} where id = ${file.id}`;
    await this.saveTranscript(note, lines ?? textToLines(text));
    await this.summariseAndSave(note, text, describe(kind));
  }

  /** Gemini reads a photo or scanned PDF (text, tables, drawings, bills). */
  private async readWithVision(note: NoteRow, mimeType: string, data: Buffer, what: string): Promise<string> {
    await this.setStatus(note.id, "extracting", `Reading the ${what}…`);
    const r = await this.d.llm.generate(
      [{ role: "user", parts: [{ type: "inline", mimeType, dataBase64: data.toString("base64") }, { type: "text", text: VISION_PROMPT }] }],
      { tier: "main", maxOutputTokens: 16000, temperature: 0 },
    );
    await this.logLlm(note, "vision", [r]);
    return r.text.trim();
  }

  /** WhatsApp export: chat text, with voice notes transcribed in place. */
  private async readWhatsApp(note: NoteRow, data: Buffer, fileName: string): Promise<string> {
    if (!fileName.toLowerCase().endsWith(".zip") && !(data[0] === 0x50 && data[1] === 0x4b)) return decodeText(data);

    const exp = await extractWhatsAppZip(data);
    const transcripts = new Map<string, string>();
    for (const [i, a] of exp.audio.entries()) {
      await this.setStatus(note.id, "transcribing", `Transcribing voice note ${i + 1} of ${exp.audio.length}…`);
      try {
        const lines = await this.transcribeAudio(note, a.data, a.name, { cleanup: false });
        transcripts.set(a.name, lines.map((l) => l.text).join(" "));
      } catch (err) {
        if (err instanceof ProviderUnavailableError) throw err; // wait for quota, then redo
        transcripts.set(a.name, "(voice note could not be transcribed)");
      }
    }
    let chat = insertVoiceNotes(exp.chat, transcripts);
    if (exp.otherAttachments.length) {
      chat += `\n\n[The export also contained ${exp.otherAttachments.length} other attachment(s) (photos/documents) that were not read: ${exp.otherAttachments.slice(0, 20).join(", ")}]`;
    }
    return chat;
  }

  // ───────────────────────── steps ─────────────────────────

  private async transcribe(note: NoteRow): Promise<TranscriptLine[]> {
    const { db, storage } = this.d;
    const [rec] = await db<{ storage_path: string; mime: string | null }[]>`
      select storage_path, mime from recordings
      where note_id = ${note.id} and deleted_at is null and upload_status = 'uploaded'
      order by created_at desc limit 1`;
    if (!rec) {
      throw new AppError(409, "NO_AUDIO", "The recording hasn't finished uploading.", "Keep the app open on Wi-Fi or mobile data; it will upload and continue.");
    }

    const original = await storage.download(rec.storage_path);
    return this.transcribeAudio(note, original, rec.storage_path.split("/").pop() ?? "audio.m4a");
  }

  /** Any audio (recording, shared voice note, WhatsApp PTT) → cleaned speaker-turn transcript. */
  private async transcribeAudio(note: NoteRow, original: Buffer, filename: string, opts: { cleanup?: boolean } = {}): Promise<TranscriptLine[]> {
    const { db, stt, env } = this.d;
    await this.setStatus(note.id, "transcribing", "Cleaning up the audio…");
    const cleaned = await cleanAudio(original, filename);
    await this.setStatus(note.id, "transcribing", "Transcribing speech…");
    const chunks = await splitAudio(cleaned.data, cleaned.filename, env.STT_MAX_MB * 1024 * 1024, env.STT_CHUNK_SECONDS);

    const results: { offsetMs: number; segments: SttSegment[] }[] = [];
    const languages = new Set<string>();
    let totalSec = 0;
    for (const [i, chunk] of chunks.entries()) {
      if (chunks.length > 1) await this.setStatus(note.id, "transcribing", `Transcribing part ${i + 1} of ${chunks.length}…`);
      const r = await stt.transcribe(chunk.data, chunk.filename, note.language_hint);
      await this.logUsage(note, { service: "stt", provider: r.provider, model: r.model, purpose: "transcribe", audioSeconds: r.durationSec });
      results.push({ offsetMs: chunk.offsetMs, segments: r.segments.length ? r.segments : [{ startMs: 0, endMs: 0, text: r.text }] });
      if (r.language) languages.add(r.language);
      totalSec += r.durationSec;
    }

    const raw = stitchSegments(results).filter((s) => s.text.trim());
    if (raw.length === 0) {
      throw new AppError(422, "SILENT_AUDIO", "No speech was found in this recording.", "Check that the microphone wasn't covered or blocked, and record closer to the speakers.");
    }
    await db`update notes set duration_sec = coalesce(duration_sec, ${totalSec}) where id = ${note.id}`;

    if (opts.cleanup === false) {
      return raw.map((s) => ({ speaker: null, text: s.text, gloss: null, startMs: s.startMs, endMs: s.endMs }));
    }
    await this.setStatus(note.id, "summarising", "Cleaning up the transcript…");
    return this.cleanup(note, raw);
  }

  /** Splits into speaker turns and fixes obvious errors; falls back to the raw transcript if the AI can't. */
  private async cleanup(note: NoteRow, raw: SttSegment[]): Promise<TranscriptLine[]> {
    const out: TranscriptLine[] = [];
    for (const group of groupByChars(raw, CLEANUP_CHARS)) {
      const speakersSoFar = [...new Set(out.map((l) => l.speaker).filter(Boolean))].join(", ");
      try {
        const res = await generateValidatedJson(
          this.d.llm,
          CleanedTranscriptSchema,
          [{ role: "user", parts: [{ type: "text", text: (speakersSoFar ? `Speaker labels used so far: ${speakersSoFar}\n\n` : "") + group.map((s) => s.text).join("\n") }] }],
          { system: cleanupSystem(note.transcript_script), tier: "lite", maxOutputTokens: 16000, temperature: 0.2 },
        );
        await this.logLlm(note, "cleanup", res.results);
        // Spread the group's time range over the cleaned turns (turn boundaries differ from Whisper's).
        const start = group[0]!.startMs;
        const end = group.at(-1)!.endMs;
        const step = (end - start) / Math.max(1, res.data.segments.length);
        res.data.segments.forEach((s, i) =>
          out.push({ speaker: s.speaker, text: s.text, gloss: s.gloss, startMs: Math.round(start + i * step), endMs: Math.round(start + (i + 1) * step) }),
        );
      } catch {
        group.forEach((s) => out.push({ speaker: null, text: s.text, gloss: null, startMs: s.startMs, endMs: s.endMs }));
      }
    }
    return out;
  }

  private async summariseAndSave(note: NoteRow, transcript: string, source?: string) {
    await this.setStatus(note.id, "summarising", note.kind === "meeting" ? "Writing your meeting note…" : "Writing your note…");
    if (transcript.length > MAX_SUMMARY_CHARS) {
      transcript =
        transcript.slice(0, MAX_SUMMARY_CHARS) +
        `\n\n[NOTE: this content is very long; only the first ${MAX_SUMMARY_CHARS.toLocaleString("en-IN")} characters were analysed. Mention this in open_questions.]`;
    }
    const res = await generateValidatedJson(
      this.d.llm,
      StructuredNoteSchema,
      [{ role: "user", parts: [{ type: "text", text: noteUserPrompt({ kind: note.kind, startedAt: note.started_at, durationSec: note.duration_sec, projectName: note.project_name, source, transcript }) }] }],
      { system: NOTE_SYSTEM, tier: "main", maxOutputTokens: 16000, temperature: 0.2 },
    );
    await this.logLlm(note, "summarise", res.results);
    const structured: StructuredNote = { ...res.data, figures: normaliseFigures(res.data.figures) };
    await this.saveStructured(note, structured, res.results.at(-1)!.model);
  }

  // ───────────────────────── persistence ─────────────────────────

  private async saveTranscript(note: NoteRow, lines: TranscriptLine[]) {
    await this.d.db.begin(async (tx) => {
      await tx`delete from transcript_segments where note_id = ${note.id}`;
      if (lines.length) {
        await tx`insert into transcript_segments ${tx(
          lines.map((l, idx) => ({
            user_id: note.user_id,
            note_id: note.id,
            idx,
            speaker_label: l.speaker,
            text: l.text,
            gloss: l.gloss,
            start_ms: l.startMs,
            end_ms: l.endMs,
          })),
        )}`;
      }
      await tx`update notes set transcript_text = ${linesToText(lines)} where id = ${note.id}`;
    });
  }

  private async saveStructured(note: NoteRow, s: StructuredNote, model: string) {
    const u = note.user_id;
    await this.d.db.begin(async (tx) => {
      await tx`
        update notes set
          title = case when user_edited then title else ${s.title} end,
          summary = case when user_edited then summary else ${s.summary} end,
          structured = ${tx.json(s as never)},
          location = coalesce(location, ${s.location}),
          languages_detected = ${s.languages_detected},
          status = 'done', progress_text = null, error_message = null, error_hint = null,
          ai_model = ${model}, prompt_version = ${PROMPT_VERSION}
        where id = ${note.id}`;

      // Replace AI-made items; keep tasks the user already completed.
      await tx`delete from tasks where note_id = ${note.id} and status = 'open'`;
      if (s.action_items.length) {
        await tx`insert into tasks ${tx(
          s.action_items.map((a) => ({
            user_id: u,
            note_id: note.id,
            project_id: note.project_id,
            owner_text: a.owner,
            title: a.task,
            due_date: isoDate(a.due_date),
            priority: a.priority,
          })),
        )}`;
      }

      await tx`delete from figures where note_id = ${note.id}`;
      if (s.figures.length) {
        await tx`insert into figures ${tx(
          s.figures.map((f) => ({
            user_id: u,
            note_id: note.id,
            project_id: note.project_id,
            kind: f.kind,
            value: f.value,
            unit: f.unit,
            currency: f.currency,
            item: f.item,
            vendor_text: f.vendor,
            reference_no: f.reference_no,
            raw_text: f.raw_text,
          })),
        )}`;
      }

      await tx`delete from follow_up_suggestions where note_id = ${note.id} and status = 'pending'`;
      if (s.follow_ups.length) {
        await tx`insert into follow_up_suggestions ${tx(
          s.follow_ups.map((f) => ({
            user_id: u,
            note_id: note.id,
            type: f.type,
            description: f.description,
            suggested_start: isoTimestamp(f.suggested_date),
          })),
        )}`;
      }
    });
  }

  private async loadNote(noteId: string): Promise<NoteRow> {
    const [row] = await this.d.db<NoteRow[]>`
      select n.id, n.user_id, n.kind, n.language_hint, n.started_at, n.duration_sec, n.project_id,
             n.transcript_text, p.name as project_name,
             coalesce(s.transcript_script, 'original') as transcript_script
      from notes n
      left join projects p on p.id = n.project_id
      left join user_settings s on s.user_id = n.user_id
      where n.id = ${noteId} and n.deleted_at is null`;
    if (!row) throw new AppError(404, "NOTE_NOT_FOUND", "This note no longer exists.");
    return row;
  }

  async setStatus(noteId: string, status: string, progress: string | null) {
    await this.d.db`update notes set status = ${status}, progress_text = ${progress} where id = ${noteId}`;
  }

  private async logLlm(note: NoteRow, purpose: string, results: LlmResult[]) {
    for (const r of results) {
      await this.logUsage(note, { service: "llm", provider: r.provider, model: r.model, purpose, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
    }
  }

  private async logUsage(
    note: NoteRow,
    u: { service: "llm" | "stt"; provider: string; model: string; purpose: string; inputTokens?: number | null; outputTokens?: number | null; audioSeconds?: number },
  ) {
    await this.d.db`
      insert into usage_events (user_id, service, provider, model, purpose, input_tokens, output_tokens, audio_seconds, note_id)
      values (${note.user_id}, ${u.service}, ${u.provider}, ${u.model}, ${u.purpose},
              ${u.inputTokens ?? null}, ${u.outputTokens ?? null}, ${u.audioSeconds ?? null}, ${note.id})`;
  }
}

// ───────────────────────── helpers (exported for tests) ─────────────────────────

export function linesToText(lines: TranscriptLine[]) {
  return lines.map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text)).join("\n");
}

/** Plain text (documents, chats) → transcript lines of up to ~1,500 characters, split at line breaks. */
export function textToLines(text: string): TranscriptLine[] {
  const rows = text.split(/\r?\n/).map((t) => ({ text: t }));
  return groupByChars(rows, 1500)
    .map((g) => g.map((r) => r.text).join("\n").trim())
    .filter(Boolean)
    .map((t) => ({ speaker: null, text: t, gloss: null, startMs: null, endMs: null }));
}

export function groupByChars<T extends { text: string }>(items: T[], maxChars: number): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    if (current.length && size + item.text.length > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.text.length + 1;
  }
  if (current.length) groups.push(current);
  return groups;
}

export function isoDate(s: string | null): string | null {
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s.slice(0, 10))) ? s.slice(0, 10) : null;
}

/** "2026-09-27" or "2026-09-27T15:30" (India time) → ISO timestamp; anything else → null. */
export function isoTimestamp(s: string | null): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2] ?? "09:00"}:00+05:30`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
