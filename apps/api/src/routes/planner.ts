import type { FastifyInstance } from "fastify";
import {
  CreateEventBody,
  CreateTaskBody,
  GeneratePlanBody,
  SetCalendarFeedBody,
  UpdateEventBody,
  UpdateSettingsBody,
  type CalendarEventDto,
  type CalendarStatus,
  type StoredPlan,
  type AgendaTaskDto,
  type TodayResponse,
} from "@sitemate/shared";
import type { Sql } from "../db/client";
import { AppError } from "../errors";
import { fetchFeedEvents, normaliseFeedUrl, storeFeedEvents, syncFeed } from "../services/calendar/sync";
import type { LlmProvider } from "../services/ai/types";
import { generatePlan } from "../services/planner/plan";
import { calendarStatus, EVENT_COLUMNS, eventsBetween, loadSettings, loadToday, TASK_COLUMNS } from "../services/planner/today";
import { addDays, localDate, zonedToUtc } from "../services/time";
import { isUuid, parse } from "../validate";

const STALE_MS = 15 * 60_000;

export function plannerRoutes({ db, llm }: { db: Sql; llm: LlmProvider }) {
  return async (app: FastifyInstance) => {
    const ownEvent = async (userId: string, id: string) => {
      if (!isUuid(id)) throw new AppError(404, "NOT_FOUND", "Meeting not found.");
      const [e] = await db<{ source: string }[]>`select source from calendar_events_cache where id = ${id} and user_id = ${userId}`;
      if (!e) throw new AppError(404, "NOT_FOUND", "Meeting not found.");
      if (e.source !== "manual") {
        throw new AppError(400, "READ_ONLY_EVENT", "This meeting comes from your Outlook calendar.", "Change it in Outlook; SiteMate will pick it up on the next refresh.");
      }
    };

    // ─────────── Today ───────────
    app.get<{ Querystring: { date?: string } }>("/v1/today", async (req): Promise<TodayResponse> => {
      const userId = req.user!.id;
      const settings = await loadSettings(db, userId);

      // Keep the calendar fresh without any background job: refresh when older than 15 minutes.
      const status = await calendarStatus(db, userId);
      const stale = !status.last_synced_at || Date.now() - new Date(status.last_synced_at).getTime() > STALE_MS;
      if (status.connected && stale) {
        await syncFeed(db, userId, settings.timezone).catch(() => undefined); // error is recorded on the account
      }

      const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? "") ? req.query.date! : localDate(settings.timezone);
      return loadToday(db, userId, date, settings);
    });

    app.post("/v1/plan", async (req): Promise<StoredPlan> => {
      const userId = req.user!.id;
      const b = parse(GeneratePlanBody, req.body);
      const settings = await loadSettings(db, userId);
      const date = localDate(settings.timezone);
      const today = await loadToday(db, userId, date, settings);
      const existing = b.kind === "morning" ? today.morning_plan : today.evening_plan;
      if (existing && !b.force) return existing;
      return generatePlan(db, llm, userId, today, b.kind);
    });

    // ─────────── calendar ───────────
    app.get("/v1/calendar/status", async (req): Promise<CalendarStatus> => calendarStatus(db, req.user!.id));

    app.put("/v1/calendar/feed", async (req): Promise<CalendarStatus & { count: number }> => {
      const userId = req.user!.id;
      const { url } = parse(SetCalendarFeedBody, req.body);
      const feed = normaliseFeedUrl(url);
      const settings = await loadSettings(db, userId);
      // Try it first, so a wrong link is reported straight away and never saved.
      const events = await fetchFeedEvents(feed, settings.timezone);
      const [acc] = await db<{ id: string }[]>`
        insert into calendar_accounts (user_id, provider, feed_url, last_synced_at, last_error)
        values (${userId}, 'ics', ${feed}, now(), null)
        on conflict (user_id) where provider = 'ics'
        do update set feed_url = excluded.feed_url, last_synced_at = now(), last_error = null
        returning id`;
      await storeFeedEvents(db, userId, acc!.id, events);
      return { ...(await calendarStatus(db, userId)), count: events.length };
    });

    app.delete("/v1/calendar/feed", async (req) => {
      await db`delete from calendar_accounts where user_id = ${req.user!.id} and provider = 'ics'`; // cascades to its events
      return { ok: true };
    });

    app.post("/v1/calendar/sync", async (req) => {
      const settings = await loadSettings(db, req.user!.id);
      return syncFeed(db, req.user!.id, settings.timezone);
    });

    app.get<{ Querystring: { from?: string; to?: string } }>("/v1/calendar/events", async (req): Promise<CalendarEventDto[]> => {
      const settings = await loadSettings(db, req.user!.id);
      const today = localDate(settings.timezone);
      const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from ?? "") ? req.query.from! : today;
      const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to ?? "") ? req.query.to! : addDays(from, 7);
      return eventsBetween(db, req.user!.id, zonedToUtc(from, "00:00", settings.timezone), zonedToUtc(addDays(to, 1), "00:00", settings.timezone));
    });

    app.post("/v1/calendar/events", async (req): Promise<CalendarEventDto> => {
      const userId = req.user!.id;
      const b = parse(CreateEventBody, req.body);
      const { timezone } = await loadSettings(db, userId);
      const allDay = !b.start_time;
      const starts = zonedToUtc(b.date, b.start_time ?? "00:00", timezone);
      const ends = allDay ? zonedToUtc(addDays(b.date, 1), "00:00", timezone) : new Date(starts.getTime() + b.duration_min * 60_000);
      const [e] = await db<CalendarEventDto[]>`
        insert into calendar_events_cache (user_id, source, external_id, title, starts_at, ends_at, location, all_day, project_id)
        values (${userId}, 'manual', ${crypto.randomUUID()}, ${b.title}, ${starts}, ${ends}, ${b.location ?? null}, ${allDay}, ${b.project_id ?? null})
        returning ${EVENT_COLUMNS(db)}`;
      return e!;
    });

    app.patch<{ Params: { id: string } }>("/v1/calendar/events/:id", async (req): Promise<CalendarEventDto> => {
      const userId = req.user!.id;
      await ownEvent(userId, req.params.id);
      const b = parse(UpdateEventBody, req.body);
      const { timezone } = await loadSettings(db, userId);
      const [cur] = await db<{ starts_at: Date; ends_at: Date | null; all_day: boolean }[]>`
        select starts_at, ends_at, all_day from calendar_events_cache where id = ${req.params.id}`;
      const curDate = localDate(timezone, cur!.starts_at);
      const date = b.date ?? curDate;
      const timeChanged = b.date !== undefined || b.start_time !== undefined || b.duration_min !== undefined;
      let starts = cur!.starts_at;
      let ends = cur!.ends_at;
      let allDay = cur!.all_day;
      if (timeChanged) {
        const curTime = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(cur!.starts_at);
        const time = b.start_time === undefined ? (cur!.all_day ? null : curTime) : b.start_time;
        const dur = b.duration_min ?? (cur!.ends_at ? Math.round((cur!.ends_at.getTime() - cur!.starts_at.getTime()) / 60_000) : 60);
        allDay = !time;
        starts = zonedToUtc(date, time ?? "00:00", timezone);
        ends = allDay ? zonedToUtc(addDays(date, 1), "00:00", timezone) : new Date(starts.getTime() + dur * 60_000);
      }
      const [e] = await db<CalendarEventDto[]>`
        update calendar_events_cache set
          title = coalesce(${b.title ?? null}, title),
          location = ${b.location === undefined ? db`location` : b.location},
          project_id = ${b.project_id === undefined ? db`project_id` : b.project_id},
          starts_at = ${starts}, ends_at = ${ends}, all_day = ${allDay}
        where id = ${req.params.id} and user_id = ${userId}
        returning ${EVENT_COLUMNS(db)}`;
      return e!;
    });

    app.delete<{ Params: { id: string } }>("/v1/calendar/events/:id", async (req) => {
      await ownEvent(req.user!.id, req.params.id);
      await db`delete from calendar_events_cache where id = ${req.params.id} and user_id = ${req.user!.id}`;
      return { ok: true };
    });

    // ─────────── tasks ───────────
    app.get<{ Querystring: { status?: string } }>("/v1/tasks", async (req): Promise<AgendaTaskDto[]> => {
      const status = req.query.status === "done" ? "done" : "open";
      return db<AgendaTaskDto[]>`
        select ${TASK_COLUMNS(db)} from tasks t
        left join projects p on p.id = t.project_id
        left join contacts c on c.id = t.owner_contact_id
        where t.user_id = ${req.user!.id} and t.status = ${status}
        order by t.due_date nulls last, t.created_at desc limit 200`;
    });

    app.post("/v1/tasks", async (req): Promise<{ id: string }> => {
      const b = parse(CreateTaskBody, req.body);
      const [t] = await db<{ id: string }[]>`
        insert into tasks (user_id, title, due_date, priority)
        values (${req.user!.id}, ${b.title}, ${b.due_date ?? null}, ${b.priority}) returning id`;
      return t!;
    });

    // ─────────── follow-up suggestions from notes (never created without a tap) ───────────
    app.post<{ Params: { id: string; action: string } }>("/v1/follow-ups/:id/:action", async (req) => {
      const userId = req.user!.id;
      const { id, action } = req.params;
      if (!isUuid(id) || (action !== "accept" && action !== "dismiss")) throw new AppError(404, "NOT_FOUND", "Suggestion not found.");
      const [f] = await db<{ note_id: string; type: string; description: string; suggested_start: Date | null; status: string }[]>`
        select note_id, type, description, suggested_start, status from follow_up_suggestions where id = ${id} and user_id = ${userId}`;
      if (!f || f.status !== "pending") throw new AppError(404, "NOT_FOUND", "Suggestion not found.");

      if (action === "dismiss") {
        await db`update follow_up_suggestions set status = 'dismissed' where id = ${id}`;
        return { ok: true, created: null };
      }
      const { timezone } = await loadSettings(db, userId);
      let created: "event" | "task";
      if (f.type === "meeting" && f.suggested_start) {
        await db`
          insert into calendar_events_cache (user_id, source, external_id, title, starts_at, ends_at, note_id)
          values (${userId}, 'manual', ${crypto.randomUUID()}, ${f.description}, ${f.suggested_start},
                  ${new Date(f.suggested_start.getTime() + 3600_000)}, ${f.note_id})`;
        created = "event";
      } else {
        const due = f.suggested_start ? localDate(timezone, f.suggested_start) : null;
        await db`
          insert into tasks (user_id, note_id, title, due_date, priority)
          values (${userId}, ${f.note_id}, ${f.type === "call" ? `Call: ${f.description}` : f.description}, ${due}, 'medium')`;
        created = "task";
      }
      await db`update follow_up_suggestions set status = 'accepted' where id = ${id}`;
      return { ok: true, created };
    });

    // ─────────── plan & reminder settings ───────────
    app.patch("/v1/settings", async (req) => {
      const b = parse(UpdateSettingsBody, req.body);
      await loadSettings(db, req.user!.id);
      await db`
        update user_settings set
          morning_plan_time = coalesce(${b.morning_plan_time ?? null}::time, morning_plan_time),
          evening_recap_time = coalesce(${b.evening_recap_time ?? null}::time, evening_recap_time),
          evening_recap_enabled = coalesce(${b.evening_recap_enabled ?? null}::boolean, evening_recap_enabled),
          reminder_minutes = coalesce(${b.reminder_minutes ?? null}::int, reminder_minutes)
        where user_id = ${req.user!.id}`;
      return { ok: true };
    });
  };
}
