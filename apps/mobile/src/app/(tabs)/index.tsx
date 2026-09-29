import type { AgendaTaskDto, CalendarEventDto, StoredPlan, TodayResponse } from "@sitemate/shared";
import { router, useFocusEffect, type Href } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { BigButton, Body, Card, ErrorBox, Field, Screen, Title } from "@/components/ui";
import { api, ApiRequestError } from "@/lib/api";
import { useGeneratePlan, useToday, useTodayAction } from "@/lib/queries";
import { sizes, useTheme } from "@/theme";

const CALENDAR_ROUTE = "/calendar" as Href;
const EVENT_ROUTE = "/calendar/event" as Href;

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
const shortDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const minutesNow = (tz: string) => {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date());
  const [h, m] = p.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

function PlanCard({ heading, plan, busy, onRefresh }: { heading: string; plan: StoredPlan; busy: boolean; onRefresh: () => void }) {
  const t = useTheme();
  const c = plan.content;
  return (
    <Card>
      <Text style={{ color: t.muted, fontSize: 14, fontWeight: "700" }}>{heading.toUpperCase()}</Text>
      <Text style={{ color: t.text, fontSize: sizes.font + 2, fontWeight: "800" }}>{c.headline}</Text>
      <Body>{c.summary}</Body>
      {c.schedule.length > 0 && (
        <View style={{ gap: 4 }}>
          <Body muted>Schedule</Body>
          {c.schedule.map((s, i) => (
            <Body key={i}>
              {s.time ? `${s.time}  ` : "•  "}
              {s.title}
              {s.note ? ` — ${s.note}` : ""}
            </Body>
          ))}
        </View>
      )}
      {c.priorities.length > 0 && (
        <View style={{ gap: 4 }}>
          <Body muted>Priorities</Body>
          {c.priorities.map((p, i) => (
            <Body key={i}>
              {i + 1}. {p.title} <Text style={{ color: t.muted }}>— {p.why}</Text>
            </Body>
          ))}
        </View>
      )}
      {c.calls_to_make.length > 0 && (
        <View style={{ gap: 4 }}>
          <Body muted>Calls to make</Body>
          {c.calls_to_make.map((p, i) => (
            <Body key={i}>
              📞 {p.who} <Text style={{ color: t.muted }}>— {p.why}</Text>
            </Body>
          ))}
        </View>
      )}
      {c.watch_outs.length > 0 && (
        <View style={{ gap: 4 }}>
          <Body muted>Watch out</Body>
          {c.watch_outs.map((w, i) => (
            <Body key={i}>⚠️ {w}</Body>
          ))}
        </View>
      )}
      <Text style={{ color: t.muted, fontSize: 13 }}>
        Written at {clock(plan.generated_at)} ·{" "}
        <Text style={{ color: t.primary, fontWeight: "700" }} onPress={busy ? undefined : onRefresh}>
          {busy ? "Refreshing…" : "Refresh plan"}
        </Text>
      </Text>
    </Card>
  );
}

function EventRow({ e }: { e: CalendarEventDto }) {
  const t = useTheme();
  const editable = e.source === "manual";
  return (
    <Pressable
      disabled={!editable}
      onPress={() =>
        router.push({
          pathname: EVENT_ROUTE as never,
          params: { id: e.id, title: e.title ?? "", startsAt: e.starts_at, endsAt: e.ends_at ?? "", allDay: e.all_day ? "1" : "0", location: e.location ?? "" },
        } as never)
      }
      style={{ paddingVertical: 8, gap: 2 }}
    >
      <Text style={{ color: t.text, fontSize: sizes.font, fontWeight: "700" }}>
        {e.all_day ? "All day" : `${clock(e.starts_at)}${e.ends_at ? `–${clock(e.ends_at)}` : ""}`}  {e.title ?? "(no title)"}
      </Text>
      {(e.location || e.attendees.length > 0) && (
        <Text style={{ color: t.muted, fontSize: 14 }}>{[e.location, e.attendees.slice(0, 3).join(", ")].filter(Boolean).join(" · ")}</Text>
      )}
      {!e.all_day && (
        <Text
          style={{ color: t.primary, fontSize: 15, fontWeight: "700", paddingTop: 4 }}
          onPress={() => router.navigate("/record")}
        >
          🎙️ Record this meeting
        </Text>
      )}
    </Pressable>
  );
}

function TaskRow({ task, overdue, onToggle }: { task: AgendaTaskDto; overdue?: boolean; onToggle: () => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start", paddingVertical: 6 }}>
      <Pressable accessibilityRole="checkbox" onPress={onToggle} hitSlop={12} style={{ minWidth: 32, minHeight: 32, justifyContent: "center" }}>
        <Text style={{ fontSize: 26, color: t.primary }}>☐</Text>
      </Pressable>
      <Pressable
        style={{ flex: 1 }}
        onPress={() => task.note_id && router.push({ pathname: "/note/[id]", params: { id: task.note_id } })}
      >
        <Text style={{ color: t.text, fontSize: sizes.font }}>
          {task.priority === "high" ? "❗ " : ""}
          {task.title}
        </Text>
        <Text style={{ color: overdue ? t.danger : t.muted, fontSize: 14 }}>
          {[overdue && task.due_date ? `overdue since ${shortDate(task.due_date)}` : null, task.owner, task.project_name].filter(Boolean).join(" · ")}
        </Text>
      </Pressable>
    </View>
  );
}

export default function TodayScreen() {
  const t = useTheme();
  const q = useToday();
  const gen = useGeneratePlan();
  const data = q.data;
  const attempted = useRef<Set<string>>(new Set());
  const [newTask, setNewTask] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void q.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const toggle = useTodayAction((id: string) => api(`/v1/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) }));
  const addTask = useTodayAction((title: string) =>
    api("/v1/tasks", { method: "POST", body: JSON.stringify({ title, due_date: data?.date ?? null }) }),
  );
  const followUp = useTodayAction((v: { id: string; action: "accept" | "dismiss" }) => api(`/v1/follow-ups/${v.id}/${v.action}`, { method: "POST", body: "{}" }));

  // Write the morning plan (after 5 AM) and evening recap (after your recap time) automatically, once each.
  const hasContent = (d: TodayResponse) => d.events.length + d.tasks_due.length + d.tasks_overdue.length + d.follow_ups.length > 0;
  useEffect(() => {
    if (!data || gen.isPending || !hasContent(data)) return;
    const now = minutesNow(data.timezone);
    const want = (kind: "morning" | "evening", ok: boolean, have: unknown) => {
      const key = `${data.date}:${kind}`;
      if (!ok || have || attempted.current.has(key)) return false;
      attempted.current.add(key);
      gen.mutate({ kind });
      return true;
    };
    if (want("evening", data.settings.evening_recap_enabled && now >= minutesOf(data.settings.evening_recap_time), data.evening_plan)) return;
    want("morning", now >= 5 * 60, data.morning_plan);
  }, [data, gen]);

  const error = q.error ?? gen.error;
  const dateLabel = data ? new Date(`${data.date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }) : "";

  return (
    <Screen>
      <Title>Today</Title>
      {data && <Body muted>{dateLabel}</Body>}
      {q.isLoading && <Body muted>Loading your day… (the first time can take up to a minute if the server was asleep)</Body>}
      {error && <ErrorBox message={(error as Error).message} hint={error instanceof ApiRequestError ? error.hint : undefined} />}

      {data && (
        <>
          {gen.isPending && <Body muted>✍️ Writing your plan…</Body>}
          {data.evening_plan && (
            <PlanCard heading="Evening recap" plan={data.evening_plan} busy={gen.isPending} onRefresh={() => gen.mutate({ kind: "evening", force: true })} />
          )}
          {data.morning_plan && (
            <PlanCard heading="Today's plan" plan={data.morning_plan} busy={gen.isPending} onRefresh={() => gen.mutate({ kind: "morning", force: true })} />
          )}
          {!data.morning_plan && !gen.isPending && !hasContent(data) && (
            <Card>
              <Body>Your day is clear — no meetings or tasks yet.</Body>
            </Card>
          )}

          <Card>
            <Body muted>Meetings</Body>
            {data.events.length === 0 && <Body muted>No meetings today.</Body>}
            {data.events.map((e) => (
              <EventRow key={e.id} e={e} />
            ))}
            {!data.calendar.connected && (
              <Body muted>Outlook isn't connected yet — you can add meetings by hand, or connect your calendar.</Body>
            )}
            {data.calendar.last_error && <Body muted>⚠️ Couldn't refresh Outlook: {data.calendar.last_error}</Body>}
            <BigButton label="＋ Add meeting" variant="secondary" onPress={() => router.push(EVENT_ROUTE)} />
            {!data.calendar.connected && <BigButton label="Connect calendar" variant="secondary" onPress={() => router.push(CALENDAR_ROUTE)} />}
          </Card>

          <Card>
            <Body muted>Tasks</Body>
            {data.tasks_overdue.length + data.tasks_due.length === 0 && <Body muted>Nothing due. 🎉</Body>}
            {data.tasks_overdue.map((x) => (
              <TaskRow key={x.id} task={x} overdue onToggle={() => toggle.mutate(x.id)} />
            ))}
            {data.tasks_due.map((x) => (
              <TaskRow key={x.id} task={x} onToggle={() => toggle.mutate(x.id)} />
            ))}
            {newTask === null ? (
              <BigButton label="＋ Add task for today" variant="secondary" onPress={() => setNewTask("")} />
            ) : (
              <>
                <Field label="New task" value={newTask} onChangeText={setNewTask} placeholder="Send BOQ to client" autoFocus />
                <BigButton
                  label="Save task"
                  disabled={!newTask.trim()}
                  loading={addTask.isPending}
                  onPress={() => addTask.mutate(newTask.trim(), { onSuccess: () => setNewTask(null) })}
                />
              </>
            )}
          </Card>

          {data.follow_ups.length > 0 && (
            <Card>
              <Body muted>Suggested follow-ups (from your notes)</Body>
              {data.follow_ups.map((f) => (
                <View key={f.id} style={{ gap: 8, paddingVertical: 6 }}>
                  <Text style={{ color: t.text, fontSize: sizes.font }}>
                    {f.type === "call" ? "📞 " : f.type === "meeting" ? "📅 " : "⏰ "}
                    {f.description}
                    {f.suggested_start ? ` (${shortDate(f.suggested_start.slice(0, 10))})` : ""}
                  </Text>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <BigButton label={f.type === "meeting" && f.suggested_start ? "Add to calendar" : "Make it a task"} onPress={() => followUp.mutate({ id: f.id, action: "accept" })} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <BigButton label="Dismiss" variant="secondary" onPress={() => followUp.mutate({ id: f.id, action: "dismiss" })} />
                    </View>
                  </View>
                </View>
              ))}
            </Card>
          )}

          <BigButton label="Refresh" variant="secondary" onPress={() => void q.refetch()} loading={q.isFetching} />
        </>
      )}
    </Screen>
  );
}
