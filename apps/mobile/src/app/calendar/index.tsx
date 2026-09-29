import { router, type Href } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { Chip } from "@/components/pickers";
import { BigButton, Body, Card, ErrorBox, Field, Screen, Title } from "@/components/ui";
import { api, ApiRequestError } from "@/lib/api";
import { useToday, useTodayAction } from "@/lib/queries";

const EVENT_ROUTE = "/calendar/event" as Href;
const isTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "never");

export default function CalendarScreen() {
  const q = useToday();
  const today = q.data;
  const [link, setLink] = useState("");
  const [morning, setMorning] = useState("07:30");
  const [evening, setEvening] = useState("19:00");
  const [eveningOn, setEveningOn] = useState(true);
  const [reminder, setReminder] = useState(15);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const s = today?.settings;
    if (!s) return;
    setMorning(s.morning_plan_time);
    setEvening(s.evening_recap_time);
    setEveningOn(s.evening_recap_enabled);
    setReminder(s.reminder_minutes);
  }, [today?.settings.morning_plan_time, today?.settings.evening_recap_time, today?.settings.evening_recap_enabled, today?.settings.reminder_minutes]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (e: unknown) => {
    setNote(null);
    setError(e);
  };
  const connect = useTodayAction(() => api<{ count: number }>("/v1/calendar/feed", { method: "PUT", body: JSON.stringify({ url: link.trim() }) }));
  const refresh = useTodayAction(() => api<{ count: number }>("/v1/calendar/sync", { method: "POST", body: "{}" }));
  const disconnect = useTodayAction(() => api("/v1/calendar/feed", { method: "DELETE" }));
  const saveSettings = useTodayAction(() =>
    api("/v1/settings", {
      method: "PATCH",
      body: JSON.stringify({ morning_plan_time: morning, evening_recap_time: evening, evening_recap_enabled: eveningOn, reminder_minutes: reminder }),
    }),
  );
  const timesOk = isTime(morning) && isTime(evening);

  return (
    <Screen>
      <BigButton label="‹ Back" variant="secondary" onPress={() => (router.canGoBack() ? router.back() : router.navigate("/"))} />
      <Title>Calendar & reminders</Title>

      <Card>
        <Body muted>Outlook calendar</Body>
        {today?.calendar.connected ? (
          <>
            <Body>✅ Connected · last refreshed {when(today.calendar.last_synced_at)}</Body>
            {today.calendar.last_error && <Body muted>⚠️ Last refresh failed: {today.calendar.last_error}</Body>}
            <BigButton
              label="Refresh now"
              variant="secondary"
              loading={refresh.isPending}
              onPress={() => {
                setError(null);
                refresh.mutate(undefined, { onSuccess: (r) => setNote(`Found ${r.count} meetings in the next 30 days.`), onError: fail });
              }}
            />
            <BigButton
              label="Disconnect calendar"
              variant="danger"
              onPress={() =>
                Alert.alert("Disconnect Outlook?", "Meetings that came from Outlook will be removed from SiteMate. Meetings you added by hand stay.", [
                  { text: "Cancel", style: "cancel" },
                  { text: "Disconnect", style: "destructive", onPress: () => disconnect.mutate(undefined, { onError: fail }) },
                ])
              }
            />
          </>
        ) : (
          <>
            <Body>
              SiteMate can read your meetings from a private, read-only link. It can never change your calendar.
            </Body>
            <Body muted>
              1. On your laptop open outlook.office.com → Settings (⚙) → Calendar → Shared calendars.{"\n"}
              2. Under "Publish a calendar" choose your calendar and "Can view all details", then Publish.{"\n"}
              3. Copy the ICS link (not the HTML one) and paste it below.
            </Body>
            <Body muted>Treat the link like a password — anyone with it can see your meetings.</Body>
            <Field label="Calendar link (ICS)" value={link} onChangeText={setLink} autoCapitalize="none" autoCorrect={false} placeholder="https://outlook.office365.com/owa/calendar/…/calendar.ics" />
            <BigButton
              label="Connect"
              disabled={link.trim().length < 10}
              loading={connect.isPending}
              onPress={() => {
                setError(null);
                connect.mutate(undefined, {
                  onSuccess: (r) => {
                    setLink("");
                    setNote(`Connected. Found ${r.count} meetings in the next 30 days.`);
                  },
                  onError: fail,
                });
              }}
            />
          </>
        )}
        {note && <Body>{note}</Body>}
        {error != null && <ErrorBox message={(error as Error).message} hint={error instanceof ApiRequestError ? error.hint : undefined} />}
      </Card>

      <BigButton label="＋ Add a meeting by hand" variant="secondary" onPress={() => router.push(EVENT_ROUTE)} />

      <Card>
        <Body muted>Daily plan & reminders</Body>
        <Field label="Morning plan at (24-hour)" value={morning} onChangeText={setMorning} keyboardType="numbers-and-punctuation" placeholder="07:30" maxLength={5} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Chip label="Evening recap: on" selected={eveningOn} onPress={() => setEveningOn(true)} />
          <Chip label="off" selected={!eveningOn} onPress={() => setEveningOn(false)} />
        </View>
        {eveningOn && <Field label="Evening recap at (24-hour)" value={evening} onChangeText={setEvening} keyboardType="numbers-and-punctuation" placeholder="19:00" maxLength={5} />}
        <Body muted>Remind me before a meeting</Body>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {[0, 5, 10, 15, 30, 60].map((m) => (
            <Chip key={m} label={m === 0 ? "At start" : `${m} min`} selected={reminder === m} onPress={() => setReminder(m)} />
          ))}
        </View>
        {!timesOk && <Body muted>Use 24-hour times like 07:30 or 19:00.</Body>}
        <BigButton
          label="Save"
          disabled={!timesOk}
          loading={saveSettings.isPending}
          onPress={() => {
            setError(null);
            saveSettings.mutate(undefined, { onSuccess: () => setNote("Saved. Reminders updated."), onError: fail });
          }}
        />
        <Body muted>
          Reminders are set on this phone, so they work without internet. If they arrive late, allow "Alarms & reminders" for SiteMate and set its battery use to "Unrestricted" in Android settings.
        </Body>
      </Card>

      {today && today.upcoming_events.length > 0 && (
        <Card>
          <Body muted>Next 7 days</Body>
          {today.upcoming_events.slice(0, 15).map((e) => (
            <Body key={e.id}>
              {new Date(e.starts_at).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })}  {e.title ?? "(no title)"}
              {e.source === "manual" ? "  ✎" : ""}
            </Body>
          ))}
        </Card>
      )}
    </Screen>
  );
}
