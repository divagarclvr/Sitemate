import type { Sql } from "../../db/client";
import { toVectorLiteral, type EmbeddingProvider } from "./embeddings";

export interface SearchFilters {
  project?: string | null; // project name (partial match)
  days?: number | null; // only notes from the last N days
  kind?: "meeting" | "memo" | "call" | "file" | "chat_export" | null;
  contact_id?: string | null;
}

export interface SearchHit {
  note_id: string;
  title: string | null;
  kind: string;
  date: string; // YYYY-MM-DD
  project: string | null;
  snippet: string;
  score: number;
}

const STOP = new Set(
  "a an the and or of to in on at for from with about what which who whom when where how did does do is are was were be been has have had me my we our you your i it its this that these those tell show give find get last week month year today yesterday any all some there their them they he she his her please can could would should will shall vs per".split(" "),
);

/** Keywords for a natural question: "What did Ramesh quote for TMT?" → ["ramesh","quote","tmt"]. Keeps Indian-script words. */
export function keywords(question: string): string[] {
  const words = question
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP.has(w));
  return [...new Set(words)].slice(0, 10);
}

/** Combines two ranked lists: an item near the top of either list ends up near the top overall. */
export function rrf<T>(lists: { key: (x: T) => string; items: T[] }[], k = 60): { key: string; score: number; item: T }[] {
  const acc = new Map<string, { score: number; item: T }>();
  for (const l of lists) {
    l.items.forEach((item, i) => {
      const key = l.key(item);
      const cur = acc.get(key);
      const add = 1 / (k + i + 1);
      if (cur) cur.score += add;
      else acc.set(key, { score: add, item });
    });
  }
  return [...acc.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.score - a.score);
}

interface Row {
  note_id: string;
  title: string | null;
  kind: string;
  occurred: Date;
  project: string | null;
  snippet: string;
}

/**
 * Finds notes for a question: exact words (full-text + spelling-tolerant title match) and meaning
 * (vector search over note pieces), merged so the best of both comes first.
 */
export async function searchNotes(
  db: Sql,
  embedder: EmbeddingProvider | null,
  userId: string,
  query: string,
  filters: SearchFilters = {},
  limit = 8,
): Promise<SearchHit[]> {
  const words = keywords(query);
  const tsq = words.map((w) => w.replace(/[^\p{L}\p{M}\p{N}]/gu, "")).filter(Boolean).join(" | ");
  const since = filters.days ? new Date(Date.now() - filters.days * 86_400_000) : null;
  const project = filters.project ? `%${filters.project}%` : null;

  const scope = () => db`
    n.user_id = ${userId} and n.deleted_at is null and n.status = 'done'
    ${since ? db`and coalesce(n.started_at, n.created_at) >= ${since}` : db``}
    ${filters.kind ? db`and n.kind = ${filters.kind}` : db``}
    ${filters.contact_id ? db`and n.contact_id = ${filters.contact_id}` : db``}
    ${project ? db`and p.name ilike ${project}` : db``}`;

  const lexical: Row[] = tsq
    ? await db<Row[]>`
        select n.id as note_id, n.title, n.kind, coalesce(n.started_at, n.created_at) as occurred, p.name as project,
               left(coalesce(n.summary, n.transcript_text, ''), 320) as snippet
        from notes n left join projects p on p.id = n.project_id
        where ${scope()} and (n.search_tsv @@ to_tsquery('simple', ${tsq}) or n.title ilike any(${db.array(words.map((w) => `%${w}%`))}))
        order by ts_rank(n.search_tsv, to_tsquery('simple', ${tsq})) desc, coalesce(n.started_at, n.created_at) desc
        limit 20`
    : [];

  let semantic: Row[] = [];
  if (embedder) {
    try {
      const [vec] = await embedder.embed([query], "query");
      const v = toVectorLiteral(vec!);
      semantic = await db<Row[]>`
        select n.id as note_id, n.title, n.kind, coalesce(n.started_at, n.created_at) as occurred, p.name as project,
               left(c.text, 320) as snippet
        from (select id, note_id, text, embedding <=> ${v}::vector as dist from search_chunks
              where user_id = ${userId} and embedding is not null order by embedding <=> ${v}::vector limit 60) c
        join notes n on n.id = c.note_id left join projects p on p.id = n.project_id
        where ${scope()}
        order by c.dist limit 30`;
    } catch {
      semantic = []; // embeddings unavailable: word search still works
    }
  }

  const seenSem = new Set<string>();
  const semNotes = semantic.filter((r) => (seenSem.has(r.note_id) ? false : (seenSem.add(r.note_id), true)));
  return rrf<Row>([
    { key: (r) => r.note_id, items: lexical },
    { key: (r) => r.note_id, items: semNotes },
  ])
    .slice(0, limit)
    .map(({ item, score }) => ({
      note_id: item.note_id,
      title: item.title,
      kind: item.kind,
      date: item.occurred.toISOString().slice(0, 10),
      project: item.project,
      snippet: item.snippet.replace(/\s+/g, " ").trim(),
      score: +score.toFixed(4),
    }));
}
