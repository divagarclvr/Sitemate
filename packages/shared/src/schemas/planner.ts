import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour time like 07:30");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-05");

export const CreateEventBody = z.object({
  title: z.string().trim().min(1).max(200),
  date: isoDate,
  start_time: hhmm.nullable().optional(), // null/omitted = all-day
  duration_min: z.number().int().min(5).max(24 * 60).default(60),
  location: z.string().trim().max(200).nullable().optional(),
  project_id: z.uuid().nullable().optional(),
});
export type CreateEventBody = z.infer<typeof CreateEventBody>;

export const UpdateEventBody = CreateEventBody.partial();

export const SetCalendarFeedBody = z.object({ url: z.string().trim().min(10).max(2000) });

export const CreateTaskBody = z.object({
  title: z.string().trim().min(1).max(300),
  due_date: isoDate.nullable().optional(),
  priority: z.enum(["high", "medium", "low"]).default("medium"),
});

export const UpdateSettingsBody = z
  .object({
    morning_plan_time: hhmm,
    evening_recap_time: hhmm,
    evening_recap_enabled: z.boolean(),
    reminder_minutes: z.number().int().min(0).max(240),
  })
  .partial();
export type UpdateSettingsBody = z.infer<typeof UpdateSettingsBody>;

export const PlanKind = z.enum(["morning", "evening"]);
export type PlanKind = z.infer<typeof PlanKind>;
export const GeneratePlanBody = z.object({ kind: PlanKind, force: z.boolean().default(false) });

/** What the AI writes for the morning plan / evening recap. */
export const DayPlanContent = z.object({
  headline: z.string().max(160),
  summary: z.string().max(900),
  schedule: z
    .array(z.object({ time: hhmm.nullable(), title: z.string().max(200), note: z.string().max(300).nullable() }))
    .max(20),
  priorities: z.array(z.object({ title: z.string().max(200), why: z.string().max(300) })).max(6),
  calls_to_make: z.array(z.object({ who: z.string().max(120), why: z.string().max(300) })).max(8),
  watch_outs: z.array(z.string().max(300)).max(6),
});
export type DayPlanContent = z.infer<typeof DayPlanContent>;

export interface CalendarEventDto {
  id: string;
  title: string | null;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  all_day: boolean;
  source: "ics" | "manual" | "microsoft" | "google";
  attendees: string[];
  project_id: string | null;
  note_id: string | null;
}

export interface AgendaTaskDto {
  id: string;
  title: string;
  due_date: string | null;
  priority: "high" | "medium" | "low";
  status: "open" | "done" | "cancelled";
  note_id: string | null;
  project_name: string | null;
  owner: string | null;
}

export interface AgendaFollowUpDto {
  id: string;
  note_id: string;
  type: "meeting" | "call" | "deadline" | "reminder";
  description: string;
  suggested_start: string | null;
}

export interface CalendarStatus {
  connected: boolean;
  last_synced_at: string | null;
  last_error: string | null;
}

export interface StoredPlan {
  content: DayPlanContent;
  generated_at: string;
}

export interface TodayResponse {
  date: string; // YYYY-MM-DD in the user's time zone
  timezone: string;
  events: CalendarEventDto[];
  tasks_overdue: AgendaTaskDto[];
  tasks_due: AgendaTaskDto[];
  follow_ups: AgendaFollowUpDto[];
  morning_plan: StoredPlan | null;
  evening_plan: StoredPlan | null;
  calendar: CalendarStatus;
  /** Reminder inputs for the phone: meetings and tasks in the next 7 days. */
  upcoming_events: CalendarEventDto[];
  upcoming_tasks: AgendaTaskDto[];
  settings: { morning_plan_time: string; evening_recap_time: string; evening_recap_enabled: boolean; reminder_minutes: number };
}
