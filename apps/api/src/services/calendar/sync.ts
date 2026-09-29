import type { Sql } from "../../db/client";
import { AppError } from "../../errors";
import { parseIcs, type IcsEvent } from "./ics";

const MAX_BYTES = 15 * 1024 * 1024;

/** Accepts webcal:// or https:// links only, and nothing that points inside this server's own network. */
export function normaliseFeedUrl(input: string): string {
  const raw = input.trim().replace(/^webcal:\/\//i, "https://");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError(400, "BAD_CALENDAR_LINK", "That doesn't look like a calendar link.", "Paste the whole ICS link from Outlook's 'Publish a calendar'.");
  }
  const host = u.hostname.toLowerCase();
  const privateHost =
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd])/i.test(host);
  if (u.protocol !== "https:" || privateHost) {
    throw new AppError(400, "BAD_CALENDAR_LINK", "Only public https calendar links can be used.", "Use the ICS link from Outlook's 'Publish a calendar'.");
  }
  return u.toString();
}

/** Downloads a published calendar and returns its meetings from yesterday to 30 days ahead. */
export async function fetchFeedEvents(
  url: string,
  tz: string,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<IcsEvent[]> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "text/calendar, */*" } });
  } catch {
    throw new AppError(502, "CALENDAR_UNREACHABLE", "Couldn't reach your calendar link.", "Check your internet, or publish the calendar again and paste the new link.");
  }
  if (!res.ok) {
    throw new AppError(
      502,
      "CALENDAR_LINK_REJECTED",
      `Your calendar link didn't work (error ${res.status}).`,
      "The link may have been un-published. Publish the calendar again and paste the new ICS link.",
    );
  }
  const body = await res.text();
  if (body.length > MAX_BYTES) throw new AppError(502, "CALENDAR_TOO_BIG", "That calendar file is too large.");
  if (!/BEGIN:VCALENDAR/i.test(body)) {
    throw new AppError(400, "NOT_A_CALENDAR", "That link isn't a calendar file.", "Use the ICS link, not the HTML link, from Outlook's 'Publish a calendar'.");
  }
  const from = new Date(now.getTime() - 24 * 3600_000);
  const to = new Date(now.getTime() + 30 * 24 * 3600_000);
  return parseIcs(body, from, to, tz);
}

/** Saves the fetched meetings, keeping any project/note links; removes meetings that were deleted in Outlook. */
export async function storeFeedEvents(db: Sql, userId: string, accountId: string, events: IcsEvent[], now = new Date()) {
  const from = new Date(now.getTime() - 24 * 3600_000);
  const to = new Date(now.getTime() + 30 * 24 * 3600_000);
  for (let i = 0; i < events.length; i += 200) {
    const rows = events.slice(i, i + 200).map((e) => ({
      user_id: userId,
      account_id: accountId,
      source: "ics",
      external_id: e.external_id,
      title: e.title,
      starts_at: e.starts_at,
      ends_at: e.ends_at,
      location: e.location,
      all_day: e.all_day,
      attendees: JSON.stringify(e.attendees),
    }));
    await db`
      insert into calendar_events_cache ${db(rows)}
      on conflict (account_id, external_id) do update set
        title = excluded.title, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
        location = excluded.location, all_day = excluded.all_day, attendees = excluded.attendees`;
  }
  const keep = events.map((e) => e.external_id);
  await db`
    delete from calendar_events_cache
    where account_id = ${accountId} and starts_at >= ${from} and starts_at <= ${to}
      and not (external_id = any(${db.array(keep)}))`;
}

/** Re-reads the user's published calendar. Records success or the error so the app can show it. */
export async function syncFeed(db: Sql, userId: string, tz: string): Promise<{ count: number }> {
  const [acc] = await db<{ id: string; feed_url: string }[]>`
    select id, feed_url from calendar_accounts where user_id = ${userId} and provider = 'ics'`;
  if (!acc?.feed_url) {
    throw new AppError(400, "NO_CALENDAR", "No calendar is connected yet.", "More → Calendar → paste your Outlook calendar link.");
  }
  try {
    const events = await fetchFeedEvents(acc.feed_url, tz);
    await storeFeedEvents(db, userId, acc.id, events);
    await db`update calendar_accounts set last_synced_at = now(), last_error = null where id = ${acc.id}`;
    return { count: events.length };
  } catch (e) {
    const msg = e instanceof AppError ? e.message : "Sync failed.";
    await db`update calendar_accounts set last_error = ${msg} where id = ${acc.id}`;
    throw e;
  }
}
