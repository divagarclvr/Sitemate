import type { CalendarEventDto, CreateEventBody } from "@sitemate/shared";
import type { Sql } from "../../db/client";
import { addDays, zonedToUtc } from "../time";
import { EVENT_COLUMNS } from "./today";

/** Adds a meeting the user confirmed or typed in (no calendar account involved). No start time = all-day. */
export async function createManualEvent(
  db: Sql,
  userId: string,
  timezone: string,
  b: CreateEventBody & { note_id?: string | null },
): Promise<CalendarEventDto> {
  const allDay = !b.start_time;
  const starts = zonedToUtc(b.date, b.start_time ?? "00:00", timezone);
  const ends = allDay ? zonedToUtc(addDays(b.date, 1), "00:00", timezone) : new Date(starts.getTime() + b.duration_min * 60_000);
  const [e] = await db<CalendarEventDto[]>`
    insert into calendar_events_cache (user_id, source, external_id, title, starts_at, ends_at, location, all_day, project_id, note_id)
    values (${userId}, 'manual', ${crypto.randomUUID()}, ${b.title}, ${starts}, ${ends}, ${b.location ?? null}, ${allDay}, ${b.project_id ?? null}, ${b.note_id ?? null})
    returning ${EVENT_COLUMNS(db)}`;
  return e!;
}
