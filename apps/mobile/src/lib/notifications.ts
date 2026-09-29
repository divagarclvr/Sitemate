import type { AgendaTaskDto, CalendarEventDto, TodayResponse } from "@sitemate/shared";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

/**
 * Reminders are scheduled on the phone itself (no push server needed, works offline):
 *  • the morning plan and evening recap, every day at your chosen times
 *  • each meeting, a few minutes before it starts
 *  • each task on the morning of its due date
 * Everything is re-created whenever Today refreshes, so changes in Outlook are picked up.
 */
const CHANNEL = "reminders";
const MAX_SCHEDULED = 60;

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: "Reminders and daily plan",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
    });
  }
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

const hm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return { hour: h ?? 0, minute: m ?? 0 };
};

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });

function meetingReminder(e: CalendarEventDto, minutes: number) {
  const at = new Date(new Date(e.starts_at).getTime() - minutes * 60_000);
  return {
    at,
    title: minutes > 0 ? `In ${minutes} min: ${e.title ?? "Meeting"}` : (e.title ?? "Meeting"),
    body: [clock(e.starts_at), e.location].filter(Boolean).join(" · ") + " — tap to open SiteMate and record it",
  };
}

function taskReminder(t: AgendaTaskDto) {
  const [y, m, d] = t.due_date!.split("-").map(Number);
  return { at: new Date(y!, m! - 1, d!, 9, 0), title: `Due today: ${t.title}`, body: t.owner ? `Owner: ${t.owner}` : "Open SiteMate to see your day." };
}

/** Replaces all scheduled reminders with the ones for the data in `today`. Returns how many were scheduled. */
export async function rescheduleReminders(today: TodayResponse): Promise<number> {
  if (!(await ensureNotificationPermission())) return 0;
  await Notifications.cancelAllScheduledNotificationsAsync();

  const channelId = Platform.OS === "android" ? CHANNEL : undefined;
  const now = Date.now();
  let count = 0;

  const daily = async (time: string, title: string, body: string) => {
    await Notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, ...hm(time), channelId },
    });
    count++;
  };
  await daily(today.settings.morning_plan_time, "Good morning ☀️", "Your plan for today is ready — tap to see it.");
  if (today.settings.evening_recap_enabled) await daily(today.settings.evening_recap_time, "Evening recap 🌙", "See what got done and what to carry over.");

  const dated: { at: Date; title: string; body: string }[] = [
    ...today.upcoming_events.map((e) => meetingReminder(e, today.settings.reminder_minutes)),
    ...today.upcoming_tasks.filter((t) => t.due_date).map(taskReminder),
  ]
    .filter((r) => r.at.getTime() > now + 5_000)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, MAX_SCHEDULED - count);

  for (const r of dated) {
    await Notifications.scheduleNotificationAsync({
      content: { title: r.title, body: r.body },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: r.at, channelId },
    });
    count++;
  }
  return count;
}
