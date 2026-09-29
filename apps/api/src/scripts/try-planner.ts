/**
 * Live check of the calendar + day plan (uses your real database and AI, then removes its test data).
 *   npm run try:planner -w @sitemate/api
 */
import { buildApp } from "../app";
import { loadEnv } from "../config/env";
import { createDb } from "../db/client";
import { createAiProviders } from "../services/ai";
import { localDate } from "../services/time";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const [user] = await db<{ id: string; email: string }[]>`select id, email from auth.users order by created_at limit 1`;
if (!user) throw new Error("No user found — log in to the app once first.");

const app = await buildApp({
  env,
  db,
  ai: createAiProviders(env),
  storage: {} as never,
  stt: {} as never,
  verifyToken: async () => ({ id: user.id, email: user.email }),
});
const call = async (method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT", url: string, body?: unknown) => {
  const res = await app.inject({ method, url, headers: { authorization: "Bearer x" }, payload: body as never });
  const json = res.body ? res.json() : null;
  if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode} ${JSON.stringify(json)}`);
  return json;
};

const created: string[] = [];
let taskId: string | null = null;
try {
  const me = await call("GET", "/v1/me");
  const tz = me.settings.timezone as string;
  const today = localDate(tz);
  console.log(`Today in ${tz}: ${today}; plan times ${me.settings.morning_plan_time} / ${me.settings.evening_recap_time}; reminder ${me.settings.reminder_minutes} min`);

  for (const e of [
    { title: "[Test] Site review – Whitefield", date: today, start_time: "10:30", duration_min: 60, location: "Whitefield" },
    { title: "[Test] Vendor call – steel rates", date: today, start_time: "15:00", duration_min: 30 },
    { title: "[Test] Holiday", date: today },
  ]) created.push((await call("POST", "/v1/calendar/events", e)).id);
  const t = await call("POST", "/v1/tasks", { title: "[Test] Send BOQ to client", due_date: today, priority: "high" });
  taskId = t.id;

  const view = await call("GET", "/v1/today");
  console.log(`Today: ${view.events.length} events, ${view.tasks_due.length} due, ${view.tasks_overdue.length} overdue, ${view.follow_ups.length} follow-ups`);
  console.log(view.events.map((e: { title: string; starts_at: string; all_day: boolean }) => `  ${e.all_day ? "all-day" : e.starts_at} ${e.title}`).join("\n"));

  const moved = await call("PATCH", `/v1/calendar/events/${created[0]}`, { start_time: "11:00" });
  console.log("Moved first meeting to", moved.starts_at);

  const plan = await call("POST", "/v1/plan", { kind: "morning", force: true });
  console.log("\nMORNING PLAN:\n" + JSON.stringify(plan.content, null, 2));
  const recap = await call("POST", "/v1/plan", { kind: "evening", force: true });
  console.log("\nEVENING RECAP headline:", recap.content.headline);
} finally {
  for (const id of created) await db`delete from calendar_events_cache where id = ${id}`;
  if (taskId) await db`delete from tasks where id = ${taskId}`;
  await db`delete from day_plans where user_id = ${user.id} and plan_date = ${localDate("Asia/Kolkata")}`;
  console.log("\n(test meetings, task and plans removed)");
  await app.close();
  await db.end();
}
