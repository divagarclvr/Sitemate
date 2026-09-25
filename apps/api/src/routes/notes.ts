import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CreateRecordingNoteBody,
  CreateTextMemoBody,
  RenameSpeakerBody,
  UpdateNoteBody,
  UpdateSegmentBody,
  UpdateTaskBody,
  type CreateRecordingNoteResponse,
  type NoteDetail,
  type NoteListItem,
} from "@sitemate/shared";
import { z } from "zod";
import type { Sql } from "../db/client";
import { AppError } from "../errors";
import { enqueue, type JobKind } from "../jobs/queue";
import type { FileStorage } from "../services/storage";
import { isUuid, parse } from "../validate";

export interface NotesRouteDeps {
  db: Sql;
  storage: FileStorage;
  /** Wake the background worker after queueing a job. */
  kickWorker: () => void;
}

const LIST_COLUMNS = (db: Sql) => db`
  n.id, n.kind, n.title, n.status, n.progress_text, n.error_message, n.started_at, n.duration_sec,
  n.project_id, p.name as project_name, n.summary,
  (select count(*)::int from tasks t where t.note_id = n.id and t.status = 'open') as open_tasks`;

export function notesRoutes({ db, storage, kickWorker }: NotesRouteDeps) {
  const queue = async (userId: string, noteId: string, kind: JobKind) => {
    await enqueue(db, { userId, noteId, kind });
    kickWorker();
  };

  /** Loads a note the user owns, or 404. */
  const ownNote = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const { id } = req.params;
    if (!isUuid(id)) throw new AppError(404, "NOTE_NOT_FOUND", "Note not found.");
    const [row] = await db<{ id: string; status: string; transcript_text: string | null; kind: string }[]>`
      select id, status, transcript_text, kind from notes
      where id = ${id} and user_id = ${req.user!.id} and deleted_at is null`;
    if (!row) throw new AppError(404, "NOTE_NOT_FOUND", "Note not found.", "It may have been deleted.");
    return row;
  };

  return async (app: FastifyInstance) => {
    // ─────────── create a recording note + get an upload URL ───────────
    app.post("/v1/notes", async (req): Promise<CreateRecordingNoteResponse> => {
      const b = parse(CreateRecordingNoteBody, req.body);
      const userId = req.user!.id;

      // Same local_id again (retry after a network drop) → same note.
      const [note] = await db<{ id: string }[]>`
        insert into notes (user_id, kind, status, language_hint, project_id, started_at, duration_sec, local_id, progress_text)
        values (${userId}, ${b.kind}, 'uploading', ${b.language_hint}, ${b.project_id ?? null}, ${b.started_at},
                ${b.duration_sec ?? null}, ${b.local_id}, 'Uploading recording…')
        on conflict (user_id, local_id) where local_id is not null
        do update set updated_at = now()
        returning id`;

      const [existing] = await db<{ upload_status: string; storage_path: string }[]>`
        select upload_status, storage_path from recordings where note_id = ${note!.id} order by created_at desc limit 1`;
      if (existing?.upload_status === "uploaded") return { note_id: note!.id, upload: null };

      const path = existing?.storage_path ?? `${userId}/recordings/${note!.id}${b.extension}`;
      if (!existing) {
        await db`
          insert into recordings (user_id, note_id, storage_path, mime, size_bytes, duration_sec, local_id)
          values (${userId}, ${note!.id}, ${path}, ${b.mime}, ${b.size_bytes}, ${b.duration_sec ?? null}, ${b.local_id})`;
      }
      const { url } = await storage.createUploadUrl(path);
      return { note_id: note!.id, upload: { url, content_type: b.mime } };
    });

    // ─────────── the phone finished uploading → start processing ───────────
    app.post<{ Params: { id: string } }>("/v1/notes/:id/recording-uploaded", async (req) => {
      const note = await ownNote(req);
      const [rec] = await db<{ id: string; storage_path: string }[]>`
        select id, storage_path from recordings where note_id = ${note.id} and deleted_at is null
        order by created_at desc limit 1`;
      if (!rec || !(await storage.exists(rec.storage_path))) {
        throw new AppError(409, "UPLOAD_MISSING", "The server didn't receive the recording.", "The app will upload it again automatically.");
      }
      await db`update recordings set upload_status = 'uploaded' where id = ${rec.id}`;
      if (!["done", "transcribing", "summarising"].includes(note.status)) {
        await db`update notes set status = 'queued', progress_text = 'Waiting to transcribe…', error_message = null, error_hint = null where id = ${note.id}`;
        await queue(req.user!.id, note.id, "process_recording");
      }
      return { ok: true };
    });

    // ─────────── quick text memo ───────────
    app.post("/v1/memos/text", async (req) => {
      const b = parse(CreateTextMemoBody, req.body);
      const userId = req.user!.id;
      const [note] = await db<{ id: string; created: boolean }[]>`
        insert into notes (user_id, kind, status, transcript_text, project_id, started_at, local_id, progress_text)
        values (${userId}, 'memo', 'queued', ${b.text}, ${b.project_id ?? null}, ${b.started_at ?? new Date().toISOString()},
                ${b.local_id}, 'Writing your note…')
        on conflict (user_id, local_id) where local_id is not null do update set updated_at = now()
        returning id, (xmax = 0) as created`;
      if (note!.created) await queue(userId, note!.id, "process_text");
      return { note_id: note!.id };
    });

    // ─────────── list ───────────
    app.get("/v1/notes", async (req): Promise<NoteListItem[]> => {
      const q = parse(
        z.object({
          project_id: z.uuid().optional(),
          q: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          before: z.iso.datetime().optional(),
        }),
        req.query,
      );
      const search = q.q?.trim();
      return db<NoteListItem[]>`
        select ${LIST_COLUMNS(db)}
        from notes n left join projects p on p.id = n.project_id
        where n.user_id = ${req.user!.id} and n.deleted_at is null
          ${q.project_id ? db`and n.project_id = ${q.project_id}` : db``}
          ${q.before ? db`and coalesce(n.started_at, n.created_at) < ${q.before}` : db``}
          ${search ? db`and (n.search_tsv @@ plainto_tsquery('simple', ${search}) or n.title ilike ${"%" + search + "%"} or n.transcript_text ilike ${"%" + search + "%"})` : db``}
        order by coalesce(n.started_at, n.created_at) desc
        limit ${q.limit}`;
    });

    // ─────────── detail ───────────
    app.get<{ Params: { id: string } }>("/v1/notes/:id", async (req): Promise<NoteDetail> => {
      const { id } = await ownNote(req);
      const [n] = await db`
        select ${LIST_COLUMNS(db)}, n.error_hint, n.language_hint, n.languages_detected, n.location,
               n.structured, n.user_edited,
               exists(select 1 from recordings r where r.note_id = n.id and r.deleted_at is null and r.upload_status = 'uploaded') as has_audio
        from notes n left join projects p on p.id = n.project_id where n.id = ${id}`;
      const [segments, tasks, figures, follow_ups] = await Promise.all([
        db`select id, idx, speaker_label, text, gloss, start_ms, edited from transcript_segments where note_id = ${id} order by idx`,
        db`select id, title, owner_text, to_char(due_date, 'YYYY-MM-DD') as due_date, priority, status from tasks where note_id = ${id} order by status, due_date nulls last, created_at`,
        db`select id, kind, value::float8 as value, unit, currency, item, vendor_text, reference_no, raw_text from figures where note_id = ${id} order by created_at`,
        db`select id, type, description, suggested_start, status from follow_up_suggestions where note_id = ${id} order by created_at`,
      ]);
      return { ...(n as unknown as NoteDetail), segments, tasks, figures, follow_ups } as unknown as NoteDetail;
    });

    // ─────────── edits ───────────
    app.patch<{ Params: { id: string } }>("/v1/notes/:id", async (req) => {
      const { id } = await ownNote(req);
      const b = parse(UpdateNoteBody, req.body);
      await db`
        update notes set
          title = coalesce(${b.title ?? null}, title),
          summary = coalesce(${b.summary ?? null}, summary),
          project_id = ${b.project_id === undefined ? db`project_id` : b.project_id},
          user_edited = user_edited or ${b.title !== undefined || b.summary !== undefined}
        where id = ${id}`;
      return { ok: true };
    });

    app.patch<{ Params: { id: string; segmentId: string } }>("/v1/notes/:id/segments/:segmentId", async (req) => {
      const { id } = await ownNote(req);
      if (!isUuid(req.params.segmentId)) throw new AppError(404, "NOT_FOUND", "Transcript line not found.");
      const b = parse(UpdateSegmentBody, req.body);
      await db`
        update transcript_segments set
          text = coalesce(${b.text ?? null}, text),
          speaker_label = ${b.speaker_label === undefined ? db`speaker_label` : b.speaker_label},
          edited = true
        where id = ${req.params.segmentId} and note_id = ${id}`;
      return { ok: true };
    });

    app.post<{ Params: { id: string } }>("/v1/notes/:id/rename-speaker", async (req) => {
      const { id } = await ownNote(req);
      const b = parse(RenameSpeakerBody, req.body);
      const r = await db`update transcript_segments set speaker_label = ${b.to} where note_id = ${id} and speaker_label = ${b.from}`;
      return { updated: r.count };
    });

    app.post<{ Params: { id: string } }>("/v1/notes/:id/resummarise", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
      const note = await ownNote(req);
      await db`update notes set status = 'queued', progress_text = 'Re-writing your note…', user_edited = false where id = ${note.id}`;
      await queue(req.user!.id, note.id, "resummarise");
      return { ok: true };
    });

    app.post<{ Params: { id: string } }>("/v1/notes/:id/retry", async (req) => {
      const note = await ownNote(req);
      const kind: JobKind = note.kind === "memo" && note.transcript_text && !(await hasAudio(db, note.id)) ? "process_text" : "process_recording";
      await db`update notes set status = 'queued', progress_text = 'Trying again…', error_message = null, error_hint = null where id = ${note.id}`;
      await queue(req.user!.id, note.id, kind);
      return { ok: true };
    });

    // ─────────── audio ───────────
    app.get<{ Params: { id: string } }>("/v1/notes/:id/audio-url", async (req) => {
      const { id } = await ownNote(req);
      const [rec] = await db<{ storage_path: string }[]>`
        select storage_path from recordings where note_id = ${id} and deleted_at is null and upload_status = 'uploaded'
        order by created_at desc limit 1`;
      if (!rec) throw new AppError(404, "NO_AUDIO", "This note has no audio (it may have been deleted to save space).");
      return { url: await storage.createDownloadUrl(rec.storage_path, 3600) };
    });

    app.delete<{ Params: { id: string } }>("/v1/notes/:id/recording", async (req) => {
      const { id } = await ownNote(req);
      await deleteAudio(db, storage, id);
      await db`insert into audit_log (user_id, action, entity, entity_id) values (${req.user!.id}, 'delete_recording', 'note', ${id})`;
      return { ok: true };
    });

    app.delete<{ Params: { id: string } }>("/v1/notes/:id", async (req) => {
      const { id } = await ownNote(req);
      await deleteAudio(db, storage, id);
      await db`update notes set deleted_at = now() where id = ${id}`;
      await db`delete from jobs where note_id = ${id} and status = 'queued'`;
      await db`insert into audit_log (user_id, action, entity, entity_id) values (${req.user!.id}, 'delete_note', 'note', ${id})`;
      return { ok: true };
    });

    // ─────────── tasks (tick off from the note screen) ───────────
    app.patch<{ Params: { id: string } }>("/v1/tasks/:id", async (req) => {
      if (!isUuid(req.params.id)) throw new AppError(404, "NOT_FOUND", "Task not found.");
      const b = parse(UpdateTaskBody, req.body);
      const r = await db`
        update tasks set
          status = coalesce(${b.status ?? null}, status),
          title = coalesce(${b.title ?? null}, title),
          due_date = ${b.due_date === undefined ? db`due_date` : b.due_date},
          completed_at = case when ${b.status ?? null}::text = 'done' then now() when ${b.status ?? null}::text is not null then null else completed_at end
        where id = ${req.params.id} and user_id = ${req.user!.id}`;
      if (r.count === 0) throw new AppError(404, "NOT_FOUND", "Task not found.");
      return { ok: true };
    });
  };
}

async function hasAudio(db: Sql, noteId: string) {
  const [r] = await db<{ n: number }[]>`select count(*)::int as n from recordings where note_id = ${noteId} and deleted_at is null`;
  return (r?.n ?? 0) > 0;
}

async function deleteAudio(db: Sql, storage: FileStorage, noteId: string) {
  const recs = await db<{ id: string; storage_path: string }[]>`
    select id, storage_path from recordings where note_id = ${noteId} and deleted_at is null`;
  await storage.remove(recs.map((r) => r.storage_path));
  if (recs.length) await db`update recordings set deleted_at = now() where note_id = ${noteId}`;
}
