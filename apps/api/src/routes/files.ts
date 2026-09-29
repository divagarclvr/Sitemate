import type { FastifyInstance } from "fastify";
import { CreateFileBody, type CreateFileResponse } from "@sitemate/shared";
import { extname } from "node:path";
import type { Sql } from "../db/client";
import { AppError } from "../errors";
import { enqueue } from "../jobs/queue";
import type { FileStorage } from "../services/storage";
import { isUuid, parse } from "../validate";

/** Keeps the original name readable but safe as a storage path. */
export function safeFileName(name: string): string {
  const ext = extname(name).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
  const base = name
    .slice(0, name.length - extname(name).length)
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "")
    .slice(0, 80);
  return `${base || "file"}${ext}`;
}

/** WhatsApp "Export chat" files are named "WhatsApp Chat with …". */
const isChatExport = (name: string) => /whatsapp chat/i.test(name);

export function filesRoutes({ db, storage, kickWorker }: { db: Sql; storage: FileStorage; kickWorker: () => void }) {
  return async (app: FastifyInstance) => {
    // ─────────── register a file + get an upload URL ───────────
    app.post("/v1/files", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req): Promise<CreateFileResponse> => {
      const b = parse(CreateFileBody, req.body);
      const userId = req.user!.id;

      if (b.related_note_id) {
        const [rel] = await db`select 1 from notes where id = ${b.related_note_id} and user_id = ${userId} and deleted_at is null`;
        if (!rel) throw new AppError(404, "NOTE_NOT_FOUND", "The meeting to attach to was not found.");
      }

      // Same local_id again (retry after a network drop) → same note and file.
      const [note] = await db<{ id: string }[]>`
        insert into notes (user_id, kind, status, title, language_hint, project_id, related_note_id, started_at, local_id, progress_text)
        values (${userId}, ${isChatExport(b.file_name) ? "chat_export" : "file"}, 'uploading', ${b.file_name}, ${b.language_hint},
                ${b.project_id ?? null}, ${b.related_note_id ?? null}, now(), ${b.local_id}, 'Uploading file…')
        on conflict (user_id, local_id) where local_id is not null do update set updated_at = now()
        returning id`;

      const [existing] = await db<{ id: string; upload_status: string; storage_path: string; mime: string | null }[]>`
        select id, upload_status, storage_path, mime from files where note_id = ${note!.id} and deleted_at is null limit 1`;
      if (existing?.upload_status === "uploaded") return { note_id: note!.id, file_id: existing.id, upload: null };

      const contentType = b.mime || "application/octet-stream";
      let file = existing;
      if (!file) {
        const path = `${userId}/files/${note!.id}/${safeFileName(b.file_name)}`;
        [file] = await db<{ id: string; upload_status: string; storage_path: string; mime: string | null }[]>`
          insert into files (user_id, note_id, project_id, original_name, mime, size_bytes, storage_path, source, local_id)
          values (${userId}, ${note!.id}, ${b.project_id ?? null}, ${b.file_name}, ${contentType}, ${b.size_bytes}, ${path}, 'share', ${b.local_id})
          returning id, upload_status, storage_path, mime`;
      }
      const { url } = await storage.createUploadUrl(file!.storage_path);
      return { note_id: note!.id, file_id: file!.id, upload: { url, content_type: file!.mime ?? contentType } };
    });

    // ─────────── the phone finished uploading → start reading it ───────────
    app.post<{ Params: { id: string } }>("/v1/files/:id/uploaded", async (req) => {
      if (!isUuid(req.params.id)) throw new AppError(404, "NOT_FOUND", "File not found.");
      const [f] = await db<{ id: string; note_id: string; storage_path: string; status: string }[]>`
        select f.id, f.note_id, f.storage_path, n.status from files f join notes n on n.id = f.note_id
        where f.id = ${req.params.id} and f.user_id = ${req.user!.id} and f.deleted_at is null`;
      if (!f) throw new AppError(404, "NOT_FOUND", "File not found.");
      if (!(await storage.exists(f.storage_path))) {
        throw new AppError(409, "UPLOAD_MISSING", "The server didn't receive the file.", "The app will upload it again automatically.");
      }
      await db`update files set upload_status = 'uploaded' where id = ${f.id}`;
      if (!["done", "extracting", "transcribing", "summarising"].includes(f.status)) {
        await db`update notes set status = 'queued', progress_text = 'Waiting to read the file…', error_message = null, error_hint = null where id = ${f.note_id}`;
        await enqueue(db, { userId: req.user!.id, noteId: f.note_id, kind: "process_file" });
        kickWorker();
      }
      return { ok: true };
    });

    // ─────────── open / re-share the original ───────────
    app.get<{ Params: { id: string } }>("/v1/files/:id/download-url", async (req) => {
      if (!isUuid(req.params.id)) throw new AppError(404, "NOT_FOUND", "File not found.");
      const [f] = await db<{ storage_path: string; original_name: string; mime: string | null }[]>`
        select storage_path, original_name, mime from files
        where id = ${req.params.id} and user_id = ${req.user!.id} and deleted_at is null and upload_status = 'uploaded'`;
      if (!f) throw new AppError(404, "NOT_FOUND", "File not found.", "It may have been deleted.");
      return { url: await storage.createDownloadUrl(f.storage_path, 3600), file_name: f.original_name, mime: f.mime };
    });
  };
}
