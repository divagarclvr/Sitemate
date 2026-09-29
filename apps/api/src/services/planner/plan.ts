import { DayPlanContent, type PlanKind, type StoredPlan, type TodayResponse } from "@sitemate/shared";
import type { Sql } from "../../db/client";
import { generateValidatedJson } from "../ai/json";
import type { LlmProvider } from "../ai/types";
import { dayBounds } from "../time";

const SYSTEM = `You are SiteMate, the personal assistant of a Senior Estimator at a construction company in Bengaluru, India.
You write short, practical plans in plain English. Site people read these on a phone between meetings.
Rules:
- Use ONLY the meetings, tasks and follow-ups in the data. Never invent meetings, people, numbers or deadlines.
- Times are 24-hour HH:MM in the user's time zone. Use null when a schedule line has no fixed time.
- Keep every line short and concrete. No greetings, no filler.
- If the data is empty, say the day is clear and suggest nothing invented.`;

const MORNING_TASK = `Write the MORNING PLAN for today.
- headline: one line that sets the tone for the day (e.g. how busy it is and what matters most).
- summary: 2-3 sentences.
- schedule: today's meetings in time order (time, title, note = location/people if useful). You may add at most 2 suggested focus blocks in free gaps for the top priorities, marked "Focus:" in the title.
- priorities: the top things to get done today (overdue and high-priority first), each with a short reason.
- calls_to_make: only calls that the follow-ups or tasks clearly ask for.
- watch_outs: clashes, back-to-back meetings, overdue items, things without a due date that look urgent.`;

const EVENING_TASK = `Write the EVENING RECAP for today.
- headline: one line on how the day went.
- summary: 2-3 sentences: what happened (meetings, notes taken, tasks finished) and what is still open.
- schedule: tomorrow's first meetings (time, title) so the user can prepare. Leave empty if none.
- priorities: what to carry over or do first tomorrow, each with a short reason.
- calls_to_make: calls still pending from follow-ups or tasks.
- watch_outs: anything that will slip if not handled.`;

interface DayContext {
  today: TodayResponse;
  notesToday: { title: string | null; kind: string; summary: string | null }[];
  doneToday: string[];
  tomorrow: { title: string | null; starts_at: string; location: string | null }[];
}

export async function loadDayContext(db: Sql, userId: string, today: TodayResponse): Promise<DayContext> {
  const { start, end } = dayBounds(today.date, today.timezone);
  const tomorrowEnd = new Date(end.getTime() + 24 * 3600_000);
  const [notesToday, done, tomorrow] = await Promise.all([
    db<{ title: string | null; kind: string; summary: string | null }[]>`
      select title, kind, left(coalesce(summary, ''), 300) as summary
      from notes where user_id = ${userId} and deleted_at is null and created_at >= ${start} and created_at < ${end}
      order by created_at limit 15`,
    db<{ title: string }[]>`
      select title from tasks where user_id = ${userId} and status = 'done' and completed_at >= ${start} and completed_at < ${end} limit 20`,
    db<{ title: string | null; starts_at: string; location: string | null }[]>`
      select title, starts_at, location from calendar_events_cache
      where user_id = ${userId} and starts_at >= ${end} and starts_at < ${tomorrowEnd} order by starts_at limit 10`,
  ]);
  return { today, notesToday, doneToday: done.map((d) => d.title), tomorrow };
}

function contextText(kind: PlanKind, c: DayContext): string {
  const t = c.today;
  const local = (iso: string | Date) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: t.timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const lines: string[] = [`Date: ${t.date} (${t.timezone})`];
  lines.push("MEETINGS TODAY:");
  if (t.events.length === 0) lines.push("- none");
  for (const e of t.events) {
    lines.push(
      `- ${e.all_day ? "all day" : `${local(e.starts_at)}${e.ends_at ? "–" + local(e.ends_at) : ""}`} ${e.title ?? "(no title)"}` +
        (e.location ? ` @ ${e.location}` : "") +
        (e.attendees.length ? ` [with ${e.attendees.slice(0, 6).join(", ")}]` : ""),
    );
  }
  const task = (x: TodayResponse["tasks_due"][number]) =>
    `- [${x.priority}] ${x.title}${x.owner ? ` (owner: ${x.owner})` : ""}${x.project_name ? ` {${x.project_name}}` : ""}${x.due_date ? ` due ${x.due_date}` : ""}`;
  lines.push("OVERDUE TASKS:", ...(t.tasks_overdue.length ? t.tasks_overdue.map(task) : ["- none"]));
  lines.push("TASKS DUE TODAY:", ...(t.tasks_due.length ? t.tasks_due.map(task) : ["- none"]));
  lines.push(
    "PENDING FOLLOW-UP SUGGESTIONS:",
    ...(t.follow_ups.length ? t.follow_ups.map((f) => `- (${f.type}) ${f.description}`) : ["- none"]),
  );
  if (kind === "evening") {
    lines.push("NOTES TAKEN TODAY:", ...(c.notesToday.length ? c.notesToday.map((n) => `- ${n.title ?? n.kind}: ${n.summary ?? ""}`) : ["- none"]));
    lines.push("TASKS FINISHED TODAY:", ...(c.doneToday.length ? c.doneToday.map((d) => `- ${d}`) : ["- none"]));
    lines.push(
      "TOMORROW'S MEETINGS:",
      ...(c.tomorrow.length ? c.tomorrow.map((e) => `- ${local(e.starts_at)} ${e.title ?? "(no title)"}${e.location ? ` @ ${e.location}` : ""}`) : ["- none"]),
    );
  }
  return lines.join("\n");
}

/** Asks the AI for the plan, saves it (one per day and kind) and returns it. */
export async function generatePlan(
  db: Sql,
  llm: LlmProvider,
  userId: string,
  today: TodayResponse,
  kind: PlanKind,
): Promise<StoredPlan> {
  const ctx = await loadDayContext(db, userId, today);
  const { data } = await generateValidatedJson(
    llm,
    DayPlanContent,
    [{ role: "user", parts: [{ type: "text", text: `${kind === "morning" ? MORNING_TASK : EVENING_TASK}\n\n${contextText(kind, ctx)}` }] }],
    { system: SYSTEM, tier: "lite", temperature: 0.3, maxOutputTokens: 2000 },
  );
  const [row] = await db<{ updated_at: string }[]>`
    insert into day_plans (user_id, plan_date, kind, content)
    values (${userId}, ${today.date}, ${kind}, ${db.json(data)})
    on conflict (user_id, plan_date, kind) do update set content = excluded.content, updated_at = now()
    returning updated_at`;
  return { content: data, generated_at: row!.updated_at };
}

export { contextText };
