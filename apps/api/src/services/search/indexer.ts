import type { Sql } from "../../db/client";
import { toVectorLiteral, type EmbeddingProvider } from "./embeddings";

/** ~1,400 characters per piece with a little overlap; long meetings are capped so the free embedding limit lasts. */
const CHUNK_CHARS = 1400;
const OVERLAP = 200;
const MAX_CHUNKS = 40;

interface NoteForIndex {
  id: string;
  user_id: string;
  project_id: string | null;
  kind: string;
  title: string | null;
  summary: string | null;
  structured: {
    key_decisions?: string[];
    action_items?: { task: string; owner: string | null; due_date: string | null }[];
    figures?: { raw_text: string; item: string | null; vendor: string | null }[];
    participants?: { name: string; company: string | null }[];
    open_questions?: string[];
  } | null;
  transcript_text: string | null;
  occurred_at: Date;
  project_name: string | null;
  contact_name: string | null;
}

/** Splits text at paragraph/sentence boundaries where possible. */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = OVERLAP): string[] {
  const clean = text.replace(/\r/g, "").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start + size * 0.6, end);
      const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("। "));
      if (cut > 0) end = start + Math.floor(size * 0.6) + cut + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

/** The pieces of a note that get searched: one dense "facts" piece first, then the transcript/text. */
export function noteChunks(n: NoteForIndex): string[] {
  const date = n.occurred_at.toISOString().slice(0, 10);
  const head = `${n.title ?? "Untitled"} — ${n.kind} on ${date}${n.project_name ? `, project ${n.project_name}` : ""}${n.contact_name ? `, with ${n.contact_name}` : ""}`;
  const s = n.structured;
  const facts = [
    head,
    n.summary,
    s?.participants?.length ? `People: ${s.participants.map((p) => (p.company ? `${p.name} (${p.company})` : p.name)).join(", ")}` : null,
    s?.key_decisions?.length ? `Decisions: ${s.key_decisions.join("; ")}` : null,
    s?.action_items?.length ? `Actions: ${s.action_items.map((a) => `${a.task}${a.owner ? ` (${a.owner})` : ""}${a.due_date ? ` by ${a.due_date}` : ""}`).join("; ")}` : null,
    s?.figures?.length ? `Figures: ${s.figures.map((f) => [f.item, f.vendor, f.raw_text].filter(Boolean).join(" ")).join("; ")}` : null,
    s?.open_questions?.length ? `Open questions: ${s.open_questions.join("; ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const pieces = [...chunkText(facts, CHUNK_CHARS * 2, 0), ...chunkText(n.transcript_text ?? "").map((c) => `${head}\n${c}`)];
  return pieces.slice(0, MAX_CHUNKS);
}

/** (Re)builds the search pieces of one note. If embedding fails, the pieces are still saved (without vectors) so a later pass can finish them. */
export async function indexNote(db: Sql, embedder: EmbeddingProvider | null, noteId: string): Promise<{ chunks: number; embedded: boolean }> {
  const [n] = await db<NoteForIndex[]>`
    select n.id, n.user_id, n.project_id, n.kind, n.title, n.summary, n.structured, n.transcript_text,
           coalesce(n.started_at, n.created_at) as occurred_at, p.name as project_name, c.name as contact_name
    from notes n left join projects p on p.id = n.project_id left join contacts c on c.id = n.contact_id
    where n.id = ${noteId} and n.deleted_at is null and n.status = 'done'`;
  if (!n) return { chunks: 0, embedded: false };

  const texts = noteChunks(n);
  let vectors: number[][] | null = null;
  if (embedder && texts.length) {
    try {
      vectors = await embedder.embed(texts, "document");
    } catch {
      vectors = null; // quota/busy: keep the text, add vectors later
    }
  }

  await db.begin(async (tx) => {
    await tx`delete from search_chunks where note_id = ${n.id}`;
    for (let i = 0; i < texts.length; i++) {
      await tx`
        insert into search_chunks (user_id, note_id, chunk_idx, text, embedding, project_id, occurred_at)
        values (${n.user_id}, ${n.id}, ${i}, ${texts[i]!}, ${vectors ? toVectorLiteral(vectors[i]!) : null}::vector, ${n.project_id}, ${n.occurred_at})`;
    }
  });
  return { chunks: texts.length, embedded: !!vectors };
}

/** Finds finished notes that were never indexed (or lack vectors) and indexes a few. Returns how many were processed. */
export async function indexMissingNotes(db: Sql, embedder: EmbeddingProvider | null, limit = 5): Promise<number> {
  const rows = await db<{ id: string }[]>`
    select n.id from notes n
    where n.status = 'done' and n.deleted_at is null
      and (not exists (select 1 from search_chunks c where c.note_id = n.id)
           or exists (select 1 from search_chunks c where c.note_id = n.id and c.embedding is null))
    order by n.created_at desc limit ${limit}`;
  let done = 0;
  for (const r of rows) {
    const res = await indexNote(db, embedder, r.id);
    if (embedder && !res.embedded && res.chunks > 0) break; // embedding is unavailable right now; try again later
    done++;
  }
  return done;
}
