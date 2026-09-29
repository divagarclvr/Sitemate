import ical, { type VEvent } from "node-ical";
import { addDays, zonedToUtc } from "../time";

export interface IcsEvent {
  external_id: string;
  title: string | null;
  starts_at: Date;
  ends_at: Date | null;
  location: string | null;
  all_day: boolean;
  attendees: string[];
}

const text = (v: unknown): string | null => {
  const s = typeof v === "string" ? v : v && typeof v === "object" && "val" in v ? String((v as { val: unknown }).val) : null;
  return s?.trim() || null;
};

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function attendeeNames(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list
    .map((a) => {
      const params = (a as { params?: { CN?: string } }).params;
      const raw = typeof a === "string" ? a : ((a as { val?: string }).val ?? "");
      return params?.CN ?? raw.replace(/^mailto:/i, "");
    })
    .filter(Boolean)
    .slice(0, 20);
}

/** Reads a calendar file (.ics) and returns the meetings between `from` and `to`, repeats included. */
export function parseIcs(icsText: string, from: Date, to: Date, tz: string): IcsEvent[] {
  const data = ical.sync.parseICS(icsText);
  const out: IcsEvent[] = [];

  for (const item of Object.values(data)) {
    if (!item || item.type !== "VEVENT") continue;
    const ev = item as VEvent;
    if (String(ev.status ?? "").toUpperCase() === "CANCELLED") continue;
    const allDay = ev.datetype === "date";

    const make = (start: Date, end: Date | undefined): IcsEvent => {
      let starts = start;
      let ends: Date | null = end ?? null;
      if (allDay) {
        // Whole-day items: Outlook gives a date, not a moment. Pin it to midnight in the user's zone.
        starts = zonedToUtc(ymd(start), "00:00", tz);
        ends = end ? zonedToUtc(ymd(end), "00:00", tz) : zonedToUtc(addDays(ymd(start), 1), "00:00", tz);
      }
      return {
        external_id: `${ev.uid}|${starts.toISOString()}`,
        title: text(ev.summary),
        starts_at: starts,
        ends_at: ends,
        location: text(ev.location),
        all_day: allDay,
        attendees: attendeeNames(ev.attendee),
      };
    };

    if (ev.rrule) {
      for (const occ of ical.expandRecurringEvent(ev, { from, to, expandOngoing: true })) {
        out.push(make(occ.start, occ.end));
      }
    } else if (ev.start) {
      const e = make(ev.start, ev.end);
      if ((e.ends_at ?? e.starts_at) >= from && e.starts_at <= to) out.push(e);
    }
  }
  return out.sort((a, b) => a.starts_at.getTime() - b.starts_at.getTime());
}
