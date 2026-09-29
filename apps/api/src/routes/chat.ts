import type { FastifyInstance } from "fastify";
import { SendChatBody, type ChatMessageDto, type ChatReply, type ChatSource, type ChatThreadDto, type ConfirmResult, type SearchHitDto } from "@sitemate/shared";
import type { Sql } from "../db/client";
import { AppError } from "../errors";
import type { LlmProvider } from "../services/ai/types";
import { actionsByIds, confirmAction, listPending, rejectAction } from "../services/chat/actions";
import { runAgent } from "../services/chat/agent";
import { loadSettings } from "../services/planner/today";
import type { EmbeddingProvider } from "../services/search/embeddings";
import { searchNotes } from "../services/search/search";
import { localDate } from "../services/time";
import { isUuid, parse } from "../validate";

/** Chat costs several AI calls per question, so it has its own tighter limit. */
const CHAT_LIMIT = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

interface MessageRow {
  id: string;
  role: "user" | "assistant";
  content: { text: string; action_ids?: string[] };
  created_at: string;
}

export function chatRoutes({ db, llm, embedder }: { db: Sql; llm: LlmProvider; embedder: EmbeddingProvider | null }) {
  const ownThread = async (userId: string, id: string) => {
    if (!isUuid(id)) throw new AppError(404, "NOT_FOUND", "Chat not found.");
    const [t] = await db<{ id: string; title: string | null }[]>`select id, title from chat_threads where id = ${id} and user_id = ${userId}`;
    if (!t) throw new AppError(404, "NOT_FOUND", "Chat not found.");
    return t;
  };

  const toDtos = async (userId: string, rows: MessageRow[]): Promise<ChatMessageDto[]> => {
    const ids = rows.map((r) => r.id);
    const sources = ids.length
      ? await db<(ChatSource & { message_id: string })[]>`
          select ms.message_id, n.id as note_id, n.title, n.kind, to_char(coalesce(n.started_at, n.created_at), 'YYYY-MM-DD') as date, coalesce(ms.snippet, '') as snippet
          from message_sources ms join notes n on n.id = ms.note_id and n.deleted_at is null
          where ms.user_id = ${userId} and ms.message_id = any(${db.array(ids)}::uuid[])`
      : [];
    const actions = await actionsByIds(db, userId, rows.flatMap((r) => r.content.action_ids ?? []));
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      text: r.content.text,
      created_at: r.created_at,
      sources: sources.filter((s) => s.message_id === r.id).map(({ message_id: _m, ...s }) => s),
      actions: actions.filter((a) => (r.content.action_ids ?? []).includes(a.id)),
    }));
  };

  return async (app: FastifyInstance) => {
    app.get("/v1/chat/threads", async (req): Promise<ChatThreadDto[]> =>
      db<ChatThreadDto[]>`select id, title, updated_at from chat_threads where user_id = ${req.user!.id} order by updated_at desc limit 30`);

    app.post("/v1/chat/threads", async (req): Promise<ChatThreadDto> => {
      const [t] = await db<ChatThreadDto[]>`insert into chat_threads (user_id) values (${req.user!.id}) returning id, title, updated_at`;
      return t!;
    });

    app.get<{ Params: { id: string } }>("/v1/chat/threads/:id", async (req): Promise<{ thread: ChatThreadDto; messages: ChatMessageDto[] }> => {
      const userId = req.user!.id;
      await ownThread(userId, req.params.id);
      const [thread] = await db<ChatThreadDto[]>`select id, title, updated_at from chat_threads where id = ${req.params.id}`;
      const rows = await db<MessageRow[]>`
        select id, role, content, created_at from chat_messages where thread_id = ${req.params.id} and role in ('user', 'assistant') order by created_at limit 200`;
      return { thread: thread!, messages: await toDtos(userId, rows) };
    });

    app.delete<{ Params: { id: string } }>("/v1/chat/threads/:id", async (req) => {
      await ownThread(req.user!.id, req.params.id);
      await db`delete from chat_threads where id = ${req.params.id}`;
      return { ok: true };
    });

    app.post<{ Params: { id: string } }>("/v1/chat/threads/:id/messages", CHAT_LIMIT, async (req): Promise<ChatReply> => {
      const userId = req.user!.id;
      const thread = await ownThread(userId, req.params.id);
      const { message } = parse(SendChatBody, req.body);

      const prior = await db<MessageRow[]>`
        select id, role, content, created_at from chat_messages
        where thread_id = ${thread.id} and role in ('user', 'assistant') order by created_at desc limit 8`;
      await db`insert into chat_messages (user_id, thread_id, role, content) values (${userId}, ${thread.id}, 'user', ${db.json({ text: message })})`;

      const settings = await loadSettings(db, userId);
      const result = await runAgent(
        llm,
        { db, embedder, userId, timezone: settings.timezone, today: localDate(settings.timezone) },
        { question: message, history: prior.reverse().map((m) => ({ role: m.role, text: m.content.text })) },
      );

      const [saved] = await db<MessageRow[]>`
        insert into chat_messages (user_id, thread_id, role, content)
        values (${userId}, ${thread.id}, 'assistant', ${db.json({ text: result.answer, action_ids: result.actions.map((a) => a.id) })})
        returning id, role, content, created_at`;
      for (const s of result.sources) {
        await db`insert into message_sources (user_id, message_id, note_id, snippet) values (${userId}, ${saved!.id}, ${s.note_id}, ${s.snippet})`;
      }
      await db`update chat_threads set updated_at = now(), title = coalesce(title, ${message.slice(0, 60)}) where id = ${thread.id}`;

      return {
        thread_id: thread.id,
        message: { id: saved!.id, role: "assistant", text: result.answer, created_at: saved!.created_at, sources: result.sources, actions: result.actions },
      };
    });

    // ─────────── confirmations ───────────
    app.get("/v1/pending-actions", async (req) => listPending(db, req.user!.id));

    app.post<{ Params: { id: string } }>("/v1/pending-actions/:id/confirm", async (req): Promise<ConfirmResult> => {
      if (!isUuid(req.params.id)) throw new AppError(404, "NOT_FOUND", "That suggestion no longer exists.");
      return confirmAction(db, req.user!.id, req.params.id);
    });

    app.post<{ Params: { id: string } }>("/v1/pending-actions/:id/reject", async (req) => {
      if (!isUuid(req.params.id)) throw new AppError(404, "NOT_FOUND", "That suggestion no longer exists.");
      await rejectAction(db, req.user!.id, req.params.id);
      return { ok: true };
    });

    // ─────────── search ───────────
    app.get<{ Querystring: { q?: string } }>("/v1/search", CHAT_LIMIT, async (req): Promise<SearchHitDto[]> => {
      const q = (req.query.q ?? "").trim();
      if (q.length < 2) return [];
      const hits = await searchNotes(db, embedder, req.user!.id, q.slice(0, 300), {}, 20);
      return hits.map(({ score: _s, ...h }) => h);
    });
  };
}
