import type { PendingActionDto } from "@sitemate/shared";
import { z } from "zod";
import type { Sql } from "../../db/client";
import { searchContacts } from "../contacts/resolve";
import { eventsBetween } from "../planner/today";
import type { EmbeddingProvider } from "../search/embeddings";
import { keywords, searchNotes } from "../search/search";
import { addDays, zonedToUtc } from "../time";
import { proposeCall, proposeEvent, proposeTask } from "./actions";

export const TOOL_NAMES = [
  "search_notes",
  "get_note",
  "search_figures",
  "list_tasks",
  "list_events",
  "find_contact",
  "propose_call",
  "propose_event",
  "propose_task",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Every tool takes the same flat set of optional arguments; each tool reads only the ones it needs. */
export const ToolArgs = z.object({
  query: z.string().nullish(),
  note_id: z.string().nullish(),
  project: z.string().nullish(),
  days: z.number().nullish(),
  status: z.enum(["open", "done"]).nullish(),
  from: z.string().nullish(),
  to: z.string().nullish(),
  title: z.string().nullish(),
  date: z.string().nullish(),
  start_time: z.string().nullish(),
  duration_min: z.number().nullish(),
  reason: z.string().nullish(),
  contact_id: z.string().nullish(),
});
export type ToolArgs = z.infer<typeof ToolArgs>;

export interface ToolContext {
  db: Sql;
  embedder: EmbeddingProvider | null;
  userId: string;
  timezone: string;
  today: string;
}

export interface ToolOutcome {
  result: unknown;
  noteIds: string[];
  actions: PendingActionDto[];
}

const isUuid = (s: string | null | undefined): s is string => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const isDate = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const d10 = (d: Date) => d.toISOString().slice(0, 10);

/** What the AI can look up or propose. Read-only, except propose_* which only *suggest* (the user confirms in the app). */
export async function runTool(ctx: ToolContext, tool: ToolName, a: ToolArgs): Promise<ToolOutcome> {
  const { db, userId } = ctx;
  const out = (result: unknown, noteIds: string[] = [], actions: PendingActionDto[] = []): ToolOutcome => ({ result, noteIds, actions });

  switch (tool) {
    case "search_notes": {
      if (!a.query?.trim()) return out({ error: "query is required" });
      const hits = await searchNotes(db, ctx.embedder, userId, a.query, { project: a.project, days: a.days }, 6);
      return out(
        hits.length ? hits.map(({ score: _s, ...h }) => h) : { message: "No matching notes found." },
        hits.map((h) => h.note_id),
      );
    }

    case "get_note": {
      if (!isUuid(a.note_id)) return out({ error: "note_id must be an id from a previous search result" });
      const [n] = await db<
        { id: string; title: string | null; kind: string; occurred: Date; project: string | null; contact: string | null; summary: string | null; structured: Record<string, unknown> | null; transcript: string | null }[]
      >`
        select n.id, n.title, n.kind, coalesce(n.started_at, n.created_at) as occurred, p.name as project, c.name as contact,
               n.summary, n.structured, left(n.transcript_text, 2500) as transcript
        from notes n left join projects p on p.id = n.project_id left join contacts c on c.id = n.contact_id
        where n.id = ${a.note_id} and n.user_id = ${userId} and n.deleted_at is null`;
      if (!n) return out({ error: "Note not found." });
      const s = n.structured ?? {};
      return out(
        {
          note_id: n.id,
          title: n.title,
          kind: n.kind,
          date: d10(n.occurred),
          project: n.project,
          contact: n.contact,
          summary: n.summary,
          participants: s.participants,
          key_decisions: s.key_decisions,
          action_items: s.action_items,
          figures: s.figures,
          open_questions: s.open_questions,
          transcript_start: n.transcript,
        },
        [n.id],
      );
    }

    case "search_figures": {
      const words = keywords(a.query ?? "");
      if (!words.length) return out({ error: "query is required (item, vendor or reference)" });
      const since = a.days ? new Date(Date.now() - a.days * 86_400_000) : null;
      const project = a.project ? `%${a.project}%` : null;
      const rows = await db<
        { note_id: string; title: string | null; occurred: Date; project: string | null; item: string | null; vendor: string | null; value: string | null; unit: string | null; currency: string | null; reference_no: string | null; raw_text: string; kind: string }[]
      >`
        select f.note_id, n.title, coalesce(n.started_at, n.created_at) as occurred, p.name as project, f.item, f.vendor_text as vendor,
               f.value, f.unit, f.currency, f.reference_no, f.raw_text, f.kind
        from figures f join notes n on n.id = f.note_id and n.deleted_at is null left join projects p on p.id = f.project_id
        where f.user_id = ${userId}
          and (coalesce(f.item, '') || ' ' || coalesce(f.vendor_text, '') || ' ' || coalesce(f.reference_no, '') || ' ' || f.raw_text) ilike any(${db.array(words.map((w) => `%${w}%`))})
          ${since ? db`and coalesce(n.started_at, n.created_at) >= ${since}` : db``}
          ${project ? db`and p.name ilike ${project}` : db``}
        order by coalesce(n.started_at, n.created_at) desc limit 80`;
      const scored = rows
        .map((r) => {
          const hay = `${r.item ?? ""} ${r.vendor ?? ""} ${r.reference_no ?? ""} ${r.raw_text}`.toLowerCase();
          return { r, score: words.filter((w) => hay.includes(w)).length };
        })
        .sort((x, y) => y.score - x.score || y.r.occurred.getTime() - x.r.occurred.getTime())
        .slice(0, 15);
      return out(
        scored.length
          ? scored.map(({ r }) => ({ note_id: r.note_id, note_title: r.title, date: d10(r.occurred), project: r.project, item: r.item, vendor: r.vendor, said: r.raw_text, value: r.value === null ? null : Number(r.value), unit: r.unit, currency: r.currency, reference_no: r.reference_no }))
          : { message: "No matching figures found." },
        scored.map(({ r }) => r.note_id),
      );
    }

    case "list_tasks": {
      const status = a.status ?? "open";
      const project = a.project ? `%${a.project}%` : null;
      const like = a.query?.trim() ? `%${a.query.trim()}%` : null;
      const rows = await db<{ id: string; title: string; due: string | null; priority: string; owner: string | null; project: string | null; note_id: string | null }[]>`
        select t.id, t.title, to_char(t.due_date, 'YYYY-MM-DD') as due, t.priority, coalesce(c.name, t.owner_text) as owner, p.name as project, t.note_id
        from tasks t left join projects p on p.id = t.project_id left join contacts c on c.id = t.owner_contact_id
        where t.user_id = ${userId} and t.status = ${status}
          ${project ? db`and p.name ilike ${project}` : db``}
          ${like ? db`and (t.title ilike ${like} or coalesce(c.name, t.owner_text, '') ilike ${like})` : db``}
        order by t.due_date nulls last, t.created_at desc limit 25`;
      return out(rows.length ? rows : { message: "No matching tasks." }, rows.flatMap((r) => (r.note_id ? [r.note_id] : [])));
    }

    case "list_events": {
      const from = isDate(a.from) ? a.from : ctx.today;
      const to = isDate(a.to) ? a.to : addDays(from, 7);
      const events = await eventsBetween(db, userId, zonedToUtc(from, "00:00", ctx.timezone), zonedToUtc(addDays(to, 1), "00:00", ctx.timezone));
      const fmt = (d: string | Date) =>
        new Intl.DateTimeFormat("en-GB", { timeZone: ctx.timezone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(d));
      return out(events.length ? events.map((e) => ({ when: e.all_day ? `${fmt(e.starts_at).slice(0, 6)} all day` : fmt(e.starts_at), title: e.title, location: e.location })) : { message: "No meetings in that range." });
    }

    case "find_contact": {
      if (!a.query?.trim()) return out({ error: "query is required" });
      const rows = await searchContacts(db, userId, a.query, 5);
      return out(rows.length ? rows.map((c) => ({ contact_id: c.id, name: c.name, company: c.company, role: c.role, phones: c.phones })) : { message: "No matching contact." });
    }

    case "propose_call": {
      if (!isUuid(a.contact_id)) return out({ error: "contact_id must come from find_contact" });
      const action = await proposeCall(db, userId, a.contact_id, a.reason ?? null);
      return out({ proposed: action.summary, note: "The user must confirm in the app; nothing has been dialled." }, [], [action]);
    }

    case "propose_event": {
      const action = await proposeEvent(db, userId, { title: a.title, date: a.date, start_time: a.start_time ?? null, duration_min: a.duration_min ?? 60 });
      return out({ proposed: action.summary, note: "The user must confirm in the app; nothing has been added yet." }, [], [action]);
    }

    case "propose_task": {
      if (!a.title?.trim()) return out({ error: "title is required" });
      const action = await proposeTask(db, userId, a.title, a.date ?? null);
      return out({ proposed: action.summary, note: "The user must confirm in the app; nothing has been added yet." }, [], [action]);
    }
  }
}
