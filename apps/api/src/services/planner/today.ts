import type { CalendarEventDto, CalendarStatus, AgendaFollowUpDto, StoredPlan, AgendaTaskDto, TodayResponse } from "@sitemate/shared";
import type { Sql } from "../../db/client";
import { addDays, dayBounds } from "../time";

export const EVENT_COLUMNS = (db: Sql) => db`
  id, title, starts_at, ends_at, location, all_day, source, project_id, note_id,
  coalesce(array(select jsonb_array_elements_text(coalesce(attendees, '[]'::jsonb))), '{}') as attendees`;

export const TASK_COLUMNS = (db: Sql) => db`
  t.id, t.title, to_char(t.due_date, 'YYYY-MM-DD') as due_date, t.priority, t.status, t.note_id,
  p.name as project_name, coalesce(c.name, t.owner_text) as owner`;

const PRIORITY_ORDER = "case t.priority when 'high' then 0 when 'medium' then 1 else 2 end";

export async function eventsBetween(db: Sql, userId: string, from: Date, to: Date): Promise<CalendarEventDto[]> {
  return db<CalendarEventDto[]>`
    select ${EVENT_COLUMNS(db)} from calendar_events_cache
    where user_id = ${userId} and starts_at < ${to} and coalesce(ends_at, starts_at) >= ${from}
    order by all_day desc, starts_at
    limit 200`;
}

export async function openTasksDueBy(db: Sql, userId: string, date: string, limit = 60): Promise<AgendaTaskDto[]> {
  return db<AgendaTaskDto[]>`
    select ${TASK_COLUMNS(db)} from tasks t
    left join projects p on p.id = t.project_id
    left join contacts c on c.id = t.owner_contact_id
    where t.user_id = ${userId} and t.status = 'open' and t.due_date <= ${date}
    order by t.due_date, ${db.unsafe(PRIORITY_ORDER)}, t.created_at
    limit ${limit}`;
}

export async function tasksDueBetween(db: Sql, userId: string, from: string, to: string): Promise<AgendaTaskDto[]> {
  return db<AgendaTaskDto[]>`
    select ${TASK_COLUMNS(db)} from tasks t
    left join projects p on p.id = t.project_id
    left join contacts c on c.id = t.owner_contact_id
    where t.user_id = ${userId} and t.status = 'open' and t.due_date >= ${from} and t.due_date <= ${to}
    order by t.due_date, ${db.unsafe(PRIORITY_ORDER)}
    limit 100`;
}

export async function pendingFollowUps(db: Sql, userId: string): Promise<AgendaFollowUpDto[]> {
  return db<AgendaFollowUpDto[]>`
    select id, note_id, type, description, suggested_start from follow_up_suggestions
    where user_id = ${userId} and status = 'pending'
    order by created_at desc limit 20`;
}

export async function calendarStatus(db: Sql, userId: string): Promise<CalendarStatus> {
  const [a] = await db<{ last_synced_at: string | null; last_error: string | null }[]>`
    select last_synced_at, last_error from calendar_accounts where user_id = ${userId} and provider = 'ics'`;
  return { connected: !!a, last_synced_at: a?.last_synced_at ?? null, last_error: a?.last_error ?? null };
}

export async function storedPlan(db: Sql, userId: string, date: string, kind: "morning" | "evening"): Promise<StoredPlan | null> {
  const [r] = await db<{ content: StoredPlan["content"]; updated_at: string }[]>`
    select content, updated_at from day_plans where user_id = ${userId} and plan_date = ${date} and kind = ${kind}`;
  return r ? { content: r.content, generated_at: r.updated_at } : null;
}

export interface UserSettingsRow {
  timezone: string;
  morning_plan_time: string;
  evening_recap_time: string;
  evening_recap_enabled: boolean;
  reminder_minutes: number;
}

export async function loadSettings(db: Sql, userId: string): Promise<UserSettingsRow> {
  const [r] = await db<UserSettingsRow[]>`
    insert into user_settings (user_id) values (${userId})
    on conflict (user_id) do update set updated_at = user_settings.updated_at
    returning timezone, to_char(morning_plan_time, 'HH24:MI') as morning_plan_time,
      to_char(evening_recap_time, 'HH24:MI') as evening_recap_time, evening_recap_enabled, reminder_minutes`;
  return r!;
}

/** Everything the Today screen and the day plan need, for one calendar day in the user's time zone. */
export async function loadToday(db: Sql, userId: string, date: string, settings: UserSettingsRow): Promise<TodayResponse> {
  const { start, end } = dayBounds(date, settings.timezone);
  const weekEnd = dayBounds(addDays(date, 7), settings.timezone).end;
  const [events, overdueAndDue, followUps, morning, evening, calendar, upcomingEvents, upcomingTasks] = await Promise.all([
    eventsBetween(db, userId, start, end),
    openTasksDueBy(db, userId, date),
    pendingFollowUps(db, userId),
    storedPlan(db, userId, date, "morning"),
    storedPlan(db, userId, date, "evening"),
    calendarStatus(db, userId),
    eventsBetween(db, userId, new Date(), weekEnd),
    tasksDueBetween(db, userId, date, addDays(date, 7)),
  ]);
  return {
    date,
    timezone: settings.timezone,
    events,
    tasks_overdue: overdueAndDue.filter((t) => t.due_date! < date),
    tasks_due: overdueAndDue.filter((t) => t.due_date === date),
    follow_ups: followUps,
    morning_plan: morning,
    evening_plan: evening,
    calendar,
    upcoming_events: upcomingEvents.filter((e) => !e.all_day),
    upcoming_tasks: upcomingTasks,
    settings: {
      morning_plan_time: settings.morning_plan_time,
      evening_recap_time: settings.evening_recap_time,
      evening_recap_enabled: settings.evening_recap_enabled,
      reminder_minutes: settings.reminder_minutes,
    },
  };
}
