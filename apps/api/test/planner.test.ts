import { describe, expect, it } from "vitest";
import { DayPlanContent, CreateEventBody } from "@sitemate/shared";
import { parseIcs } from "../src/services/calendar/ics";
import { fetchFeedEvents, normaliseFeedUrl } from "../src/services/calendar/sync";
import { contextText } from "../src/services/planner/plan";
import { addDays, dayBounds, localDate, zonedToUtc } from "../src/services/time";

const TZ = "Asia/Kolkata";

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  "BEGIN:VTIMEZONE",
  "TZID:India Standard Time",
  "BEGIN:STANDARD",
  "DTSTART:16010101T000000",
  "TZOFFSETFROM:+0530",
  "TZOFFSETTO:+0530",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:weekly-1",
  "DTSTART;TZID=India Standard Time:20260930T103000",
  "DTEND;TZID=India Standard Time:20260930T113000",
  "SUMMARY:Site review",
  "LOCATION:Whitefield",
  "RRULE:FREQ=WEEKLY;BYDAY=WE",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:holiday-1",
  "DTSTART;VALUE=DATE:20261002",
  "DTEND;VALUE=DATE:20261003",
  "SUMMARY:Gandhi Jayanti",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:cancelled-1",
  "DTSTART:20261001T040000Z",
  "DTEND:20261001T050000Z",
  "SUMMARY:Cancelled meeting",
  "STATUS:CANCELLED",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:far-away",
  "DTSTART:20270601T040000Z",
  "DTEND:20270601T050000Z",
  "SUMMARY:Next year",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("time helpers", () => {
  it("converts a local time in India to the right UTC moment", () => {
    expect(zonedToUtc("2026-10-05", "10:30", TZ).toISOString()).toBe("2026-10-05T05:00:00.000Z");
    expect(zonedToUtc("2026-10-05", "00:00", TZ).toISOString()).toBe("2026-10-04T18:30:00.000Z");
  });

  it("knows today's date in the user's zone, not the server's", () => {
    // 22:00 UTC on 4 Oct is already 5 Oct in India.
    expect(localDate(TZ, new Date("2026-10-04T22:00:00Z"))).toBe("2026-10-05");
    expect(localDate("UTC", new Date("2026-10-04T22:00:00Z"))).toBe("2026-10-04");
  });

  it("adds days across month ends and builds day bounds", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    const { start, end } = dayBounds("2026-10-05", TZ);
    expect(end.getTime() - start.getTime()).toBe(24 * 3600_000);
  });
});

describe("parseIcs (Outlook published calendar)", () => {
  const from = new Date("2026-09-29T00:00:00Z");
  const to = new Date("2026-10-30T00:00:00Z");
  const events = parseIcs(ICS, from, to, TZ);

  it("expands a weekly repeating meeting with the right India time", () => {
    const weekly = events.filter((e) => e.title === "Site review");
    expect(weekly.map((e) => e.starts_at.toISOString())).toEqual([
      "2026-09-30T05:00:00.000Z",
      "2026-10-07T05:00:00.000Z",
      "2026-10-14T05:00:00.000Z",
      "2026-10-21T05:00:00.000Z",
      "2026-10-28T05:00:00.000Z",
    ]);
    expect(weekly[0]!.location).toBe("Whitefield");
    expect(new Set(weekly.map((e) => e.external_id)).size).toBe(5);
  });

  it("pins whole-day items to midnight in the user's zone", () => {
    const h = events.find((e) => e.title === "Gandhi Jayanti")!;
    expect(h.all_day).toBe(true);
    expect(h.starts_at.toISOString()).toBe("2026-10-01T18:30:00.000Z");
    expect(h.ends_at!.toISOString()).toBe("2026-10-02T18:30:00.000Z");
  });

  it("skips cancelled meetings and meetings outside the window", () => {
    expect(events.find((e) => e.title === "Cancelled meeting")).toBeUndefined();
    expect(events.find((e) => e.title === "Next year")).toBeUndefined();
  });

  it("returns meetings in time order", () => {
    const times = events.map((e) => e.starts_at.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("calendar link handling", () => {
  it("accepts webcal:// and https links, rejects private or non-https ones", () => {
    expect(normaliseFeedUrl("webcal://outlook.office365.com/owa/calendar/x/reachcalendar.ics")).toMatch(/^https:\/\/outlook\.office365\.com/);
    expect(() => normaliseFeedUrl("http://example.com/a.ics")).toThrow();
    expect(() => normaliseFeedUrl("https://localhost/a.ics")).toThrow();
    expect(() => normaliseFeedUrl("https://192.168.1.5/a.ics")).toThrow();
    expect(() => normaliseFeedUrl("https://169.254.169.254/latest")).toThrow();
    expect(() => normaliseFeedUrl("not a link")).toThrow();
  });

  const reply = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

  it("reads a feed and explains problems in plain words", async () => {
    const now = new Date("2026-09-29T05:00:00Z");
    const ok = await fetchFeedEvents("https://x.test/a.ics", TZ, now, reply(200, ICS));
    expect(ok.length).toBeGreaterThan(3);
    await expect(fetchFeedEvents("https://x.test/a.ics", TZ, now, reply(404, "no"))).rejects.toMatchObject({ code: "CALENDAR_LINK_REJECTED" });
    await expect(fetchFeedEvents("https://x.test/a.ics", TZ, now, reply(200, "<html>sign in</html>"))).rejects.toMatchObject({ code: "NOT_A_CALENDAR" });
  });
});

describe("plan input and output", () => {
  it("validates a well-formed plan and rejects a bad time", () => {
    const good = {
      headline: "Busy day",
      summary: "Two meetings.",
      schedule: [{ time: "10:30", title: "Site review", note: null }],
      priorities: [{ title: "Send BOQ", why: "Overdue" }],
      calls_to_make: [],
      watch_outs: [],
    };
    expect(DayPlanContent.safeParse(good).success).toBe(true);
    expect(DayPlanContent.safeParse({ ...good, schedule: [{ time: "25:00", title: "x", note: null }] }).success).toBe(false);
  });

  it("puts meetings, overdue tasks and follow-ups into the AI prompt", () => {
    const today = {
      date: "2026-10-05",
      timezone: TZ,
      events: [
        { id: "1", title: "Site review", starts_at: "2026-10-05T05:00:00Z", ends_at: "2026-10-05T06:00:00Z", location: "Whitefield", all_day: false, source: "ics", attendees: ["Ramesh"], project_id: null, note_id: null },
      ],
      tasks_overdue: [{ id: "t1", title: "Send BOQ", due_date: "2026-10-01", priority: "high", status: "open", note_id: null, project_name: "Essence", owner: "Ramesh" }],
      tasks_due: [],
      follow_ups: [{ id: "f1", note_id: "n1", type: "call", description: "Call steel vendor", suggested_start: null }],
    } as never;
    const text = contextText("morning", { today, notesToday: [], doneToday: [], tomorrow: [] });
    expect(text).toContain("10:30–11:30 Site review @ Whitefield");
    expect(text).toContain("[high] Send BOQ");
    expect(text).toContain("(call) Call steel vendor");
  });
});

describe("manual meeting input", () => {
  it("defaults to one hour and allows all-day (no start time)", () => {
    const b = CreateEventBody.parse({ title: "Client visit", date: "2026-10-05", start_time: "14:00" });
    expect(b.duration_min).toBe(60);
    expect(CreateEventBody.safeParse({ title: "Holiday", date: "2026-10-05" }).success).toBe(true);
    expect(CreateEventBody.safeParse({ title: "x", date: "5 Oct" }).success).toBe(false);
  });
});
