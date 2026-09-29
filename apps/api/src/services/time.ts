/** Time-zone helpers (no libraries): "today" and "10:30" always mean the user's own time zone. */

function offsetMs(tz: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** "2026-10-05" + "10:30" in `tz` → the real moment in time. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetMs(tz, new Date(guess));
  return new Date(guess - offsetMs(tz, new Date(first)));
}

/** Today's date (YYYY-MM-DD) in `tz`. */
export function localDate(tz: string, at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Current time HH:MM in `tz`. */
export function localTime(tz: string, at = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(at);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function dayBounds(date: string, tz: string) {
  return { start: zonedToUtc(date, "00:00", tz), end: zonedToUtc(addDays(date, 1), "00:00", tz) };
}
