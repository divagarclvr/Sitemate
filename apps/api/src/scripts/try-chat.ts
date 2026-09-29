/**
 * Live check of search + chat on your real notes (uses your real database and AI).
 *   npm run try:chat -w @sitemate/api -- "your question" "another question"
 * Indexes any notes that are not searchable yet, asks the questions, then removes its own test chat.
 */
import { buildApp } from "../app";
import { loadEnv } from "../config/env";
import { createDb } from "../db/client";
import { createAiProviders } from "../services/ai";
import { GeminiEmbeddings } from "../services/search/embeddings";
import { indexMissingNotes } from "../services/search/indexer";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const embedder = new GeminiEmbeddings(env.GEMINI_API_KEY, env.GEMINI_EMBED_MODEL);
const [user] = await db<{ id: string; email: string }[]>`select id, email from auth.users order by created_at limit 1`;
if (!user) throw new Error("No user found — log in to the app once first.");

/** Prints how long each AI call takes, so slow steps are easy to spot. */
function timed(ai: ReturnType<typeof createAiProviders>): ReturnType<typeof createAiProviders> {
  const inner = ai.llm;
  const llm = {
    name: inner.name,
    modelFor: inner.modelFor.bind(inner),
    async generate(...args: Parameters<typeof inner.generate>) {
      const t0 = Date.now();
      try {
        const r = await inner.generate(...args);
        console.log(`   · AI call ${((Date.now() - t0) / 1000).toFixed(1)} s (${r.provider} ${r.model}, ${r.inputTokens ?? "?"} in / ${r.outputTokens ?? "?"} out)`);
        return r;
      } catch (e) {
        console.log(`   · AI call failed after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${(e as Error).message}`);
        throw e;
      }
    },
  };
  return { ...ai, llm };
}

const questions = process.argv.slice(2);
if (!questions.length) questions.push("What did the vendors quote for steel?", "What tasks are still pending?");

const startedAt = new Date();
let threadId: string | null = null;
try {
  let n = 0;
  for (;;) {
    const done = await indexMissingNotes(db, embedder, 10);
    n += done;
    if (done < 10) break;
  }
  const [{ notes, chunks, vectors }] = await db<{ notes: number; chunks: number; vectors: number }[]>`
    select count(distinct note_id)::int as notes, count(*)::int as chunks, count(embedding)::int as vectors from search_chunks where user_id = ${user.id}`;
  console.log(`Indexed ${n} notes now; searchable: ${notes} notes, ${chunks} pieces, ${vectors} with meaning vectors\n`);

  const app = await buildApp({
    env,
    db,
    ai: timed(createAiProviders(env)),
    storage: {} as never,
    stt: {} as never,
    embedder,
    verifyToken: async () => ({ id: user.id, email: user.email }),
  });
  const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const res = await app.inject({ method, url, headers: { authorization: "Bearer x" }, payload: body as never });
    const json = res.body ? res.json() : null;
    if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode} ${JSON.stringify(json)}`);
    return json;
  };

  threadId = (await call("POST", "/v1/chat/threads")).id as string;
  for (const q of questions) {
    const t0 = Date.now();
    const r = await call("POST", `/v1/chat/threads/${threadId}/messages`, { message: q });
    console.log(`Q: ${q}\nA: ${r.message.text}`);
    for (const s of r.message.sources) console.log(`   📄 ${s.title ?? "(untitled)"} · ${s.date}`);
    for (const a of r.message.actions) console.log(`   ⏳ suggested (not done): ${a.summary}`);
    console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)} s)\n`);
  }
  await app.close();
} finally {
  if (threadId) await db`delete from chat_threads where id = ${threadId}`;
  await db`delete from pending_actions where user_id = ${user.id} and created_at >= ${startedAt} and origin = 'chat'`;
  console.log("(test chat and suggestions removed)");
  await db.end();
}
