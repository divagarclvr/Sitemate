import { CreateEventBody, type ConfirmResult, type PendingActionDto, type PendingActionKind } from "@sitemate/shared";
import type { Sql } from "../../db/client";
import { AppError } from "../../errors";
import { createManualEvent } from "../planner/events";
import { loadSettings } from "../planner/today";

/**
 * The confirmation gate. The chat can only *propose* a call, meeting or task: a row is saved as
 * "pending", and nothing happens until the user taps Confirm in the app.
 */

interface CallPayload {
  contact_id: string;
  name: string;
  company: string | null;
  phones: string[];
  reason: string | null;
}
interface EventPayload {
  title: string;
  date: string;
  start_time: string | null;
  duration_min: number;
  location?: string | null;
}
interface TaskPayload {
  title: string;
  due_date: string | null;
  priority: "high" | "medium" | "low";
}

export function summarise(kind: PendingActionKind, p: Record<string, unknown>): string {
  if (kind === "call") {
    const c = p as unknown as CallPayload;
    return `Call ${c.name}${c.company ? ` (${c.company})` : ""}${c.reason ? ` — ${c.reason}` : ""}`;
  }
  if (kind === "calendar_event") {
    const e = p as unknown as EventPayload;
    return `Add meeting “${e.title}” on ${e.date}${e.start_time ? ` at ${e.start_time}` : " (all day)"}${e.start_time ? `, ${e.duration_min} min` : ""}`;
  }
  const t = p as unknown as TaskPayload;
  return `Add task “${t.title}”${t.due_date ? `, due ${t.due_date}` : ""}`;
}

async function insert(db: Sql, userId: string, kind: PendingActionKind, payload: Record<string, unknown>): Promise<PendingActionDto> {
  const [r] = await db<{ id: string }[]>`
    insert into pending_actions (user_id, kind, payload, origin) values (${userId}, ${kind}, ${db.json(payload as never)}, 'chat') returning id`;
  return { id: r!.id, kind, status: "pending", summary: summarise(kind, payload), payload };
}

export async function proposeCall(db: Sql, userId: string, contactId: string, reason: string | null): Promise<PendingActionDto> {
  const [c] = await db<{ id: string; name: string; company: string | null; phones: string[] }[]>`
    select id, name, company, phones from contacts where id = ${contactId} and user_id = ${userId}`;
  if (!c) throw new AppError(404, "NOT_FOUND", "Contact not found.");
  if (!c.phones.length) throw new AppError(400, "NO_PHONE", `${c.name} has no phone number saved.`);
  return insert(db, userId, "call", { contact_id: c.id, name: c.name, company: c.company, phones: c.phones, reason });
}

export async function proposeEvent(db: Sql, userId: string, input: unknown): Promise<PendingActionDto> {
  const parsed = CreateEventBody.safeParse(input);
  if (!parsed.success) throw new AppError(400, "BAD_EVENT", `That meeting isn't valid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const e = parsed.data;
  return insert(db, userId, "calendar_event", { title: e.title, date: e.date, start_time: e.start_time ?? null, duration_min: e.duration_min, location: e.location ?? null });
}

export async function proposeTask(db: Sql, userId: string, title: string, dueDate: string | null): Promise<PendingActionDto> {
  return insert(db, userId, "task", { title: title.trim().slice(0, 300), due_date: dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : null, priority: "medium" });
}

export async function listPending(db: Sql, userId: string): Promise<PendingActionDto[]> {
  const rows = await db<{ id: string; kind: PendingActionKind; status: PendingActionDto["status"]; payload: Record<string, unknown> }[]>`
    select id, kind, status, payload from pending_actions
    where user_id = ${userId} and status = 'pending' and expires_at > now() order by created_at desc limit 50`;
  return rows.map((r) => ({ ...r, summary: summarise(r.kind, r.payload) }));
}

export async function actionsByIds(db: Sql, userId: string, ids: string[]): Promise<PendingActionDto[]> {
  if (!ids.length) return [];
  const rows = await db<{ id: string; kind: PendingActionKind; status: PendingActionDto["status"]; payload: Record<string, unknown>; expires_at: Date }[]>`
    select id, kind, status, payload, expires_at from pending_actions where user_id = ${userId} and id = any(${db.array(ids)}::uuid[]) order by created_at`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status === "pending" && r.expires_at < new Date() ? "expired" : r.status,
    payload: r.payload,
    summary: summarise(r.kind, r.payload),
  }));
}

/** Runs a confirmed action. Calls are returned to the app, which opens the dialer. */
export async function confirmAction(db: Sql, userId: string, id: string): Promise<ConfirmResult> {
  const [a] = await db<{ kind: PendingActionKind; payload: Record<string, unknown>; status: string; expires_at: Date }[]>`
    select kind, payload, status, expires_at from pending_actions where id = ${id} and user_id = ${userId}`;
  if (!a) throw new AppError(404, "NOT_FOUND", "That suggestion no longer exists.");
  if (a.status !== "pending") throw new AppError(409, "ALREADY_HANDLED", `That suggestion was already ${a.status}.`);
  if (a.expires_at < new Date()) {
    await db`update pending_actions set status = 'expired' where id = ${id}`;
    throw new AppError(410, "EXPIRED", "That suggestion has expired.", "Ask again in the chat.");
  }

  let result: ConfirmResult;
  if (a.kind === "call") {
    const c = a.payload as unknown as CallPayload;
    result = { ok: true, kind: "call", dial: { contact_id: c.contact_id, name: c.name, phones: c.phones } };
  } else if (a.kind === "calendar_event") {
    const e = a.payload as unknown as EventPayload;
    const { timezone } = await loadSettings(db, userId);
    await createManualEvent(db, userId, timezone, CreateEventBody.parse(e));
    result = { ok: true, kind: "calendar_event", created: "event" };
  } else if (a.kind === "task") {
    const t = a.payload as unknown as TaskPayload;
    await db`insert into tasks (user_id, title, due_date, priority) values (${userId}, ${t.title}, ${t.due_date}, ${t.priority})`;
    result = { ok: true, kind: "task", created: "task" };
  } else {
    throw new AppError(400, "UNSUPPORTED", "That kind of suggestion can't be confirmed yet.");
  }
  await db`update pending_actions set status = 'confirmed' where id = ${id}`;
  await db`insert into audit_log (user_id, action, entity, entity_id, meta) values (${userId}, 'confirm_action', 'pending_action', ${id}, ${db.json({ kind: a.kind })})`;
  return result;
}

export async function rejectAction(db: Sql, userId: string, id: string) {
  const r = await db`update pending_actions set status = 'rejected' where id = ${id} and user_id = ${userId} and status = 'pending'`;
  if (r.count === 0) throw new AppError(404, "NOT_FOUND", "That suggestion no longer exists.");
}
