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
import type { LlmProvider, LlmResult } from "../ai/types";
import type { FileStorage } from "../storage";
import { splitAudio, stitchSegments } from "../stt/chunker";
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

  // ───────────────────────── steps ─────────────────────────

  private async transcribe(note: NoteRow): Promise<TranscriptLine[]> {
    const { db, storage, stt, env } = this.d;
    const [rec] = await db<{ storage_path: string; mime: string | null }[]>`
      select storage_path, mime from recordings
      where note_id = ${note.id} and deleted_at is null and upload_status = 'uploaded'
      order by created_at desc limit 1`;
    if (!rec) {
      throw new AppError(409, "NO_AUDIO", "The recording hasn't finished uploading.", "Keep the app open on Wi-Fi or mobile data; it will upload and continue.");
    }

    await this.setStatus(note.id, "transcribing", "Transcribing speech…");
    const audio = await storage.download(rec.storage_path);
    const filename = rec.storage_path.split("/").pop() ?? "audio.m4a";
    const chunks = await splitAudio(audio, filename, env.STT_MAX_MB * 1024 * 1024, env.STT_CHUNK_SECONDS);

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

  private async summariseAndSave(note: NoteRow, transcript: string) {
    await this.setStatus(note.id, "summarising", "Writing your meeting note…");
    const res = await generateValidatedJson(
      this.d.llm,
      StructuredNoteSchema,
      [{ role: "user", parts: [{ type: "text", text: noteUserPrompt({ kind: note.kind, startedAt: note.started_at, durationSec: note.duration_sec, projectName: note.project_name, transcript }) }] }],
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
