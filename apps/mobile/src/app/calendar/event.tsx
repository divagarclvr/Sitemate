import { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, View } from "react-native";
import { Chip } from "@/components/pickers";
import { BigButton, Body, ErrorBox, Field, Screen, Title } from "@/components/ui";
import { api, ApiRequestError } from "@/lib/api";
import { useTodayAction } from "@/lib/queries";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Add a meeting by hand (or edit one you added). Meetings from Outlook are changed in Outlook. */
export default function EventScreen() {
  const p = useLocalSearchParams<{ id?: string; title?: string; startsAt?: string; endsAt?: string; allDay?: string; location?: string }>();
  const editing = !!p.id;

  const initialStart = p.startsAt ? new Date(p.startsAt) : (() => {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return d;
  })();
  const initialDuration = p.startsAt && p.endsAt && p.allDay !== "1" ? Math.max(5, Math.round((new Date(p.endsAt).getTime() - initialStart.getTime()) / 60_000)) : 60;

  const [title, setTitle] = useState(p.title ?? "");
  const [when, setWhen] = useState(initialStart);
  const [allDay, setAllDay] = useState(p.allDay === "1");
  const [duration, setDuration] = useState(initialDuration);
  const [location, setLocation] = useState(p.location ?? "");
  const [error, setError] = useState<unknown>(null);

  const pick = (mode: "date" | "time") =>
    DateTimePickerAndroid.open({
      value: when,
      mode,
      is24Hour: true,
      onValueChange: (_e, d) => {
        const next = new Date(when);
        if (mode === "date") next.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
        else next.setHours(d.getHours(), d.getMinutes(), 0, 0);
        setWhen(next);
      },
    });

  const save = useTodayAction(async () => {
    const body = {
      title: title.trim(),
      date: ymd(when),
      start_time: allDay ? null : hm(when),
      duration_min: duration,
      location: location.trim() || null,
    };
    await api(editing ? `/v1/calendar/events/${p.id}` : "/v1/calendar/events", { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) });
  });
  const remove = useTodayAction(() => api(`/v1/calendar/events/${p.id}`, { method: "DELETE" }));

  const submit = () => save.mutate(undefined, { onSuccess: () => router.back(), onError: setError });
  const confirmRemove = () =>
    Alert.alert("Delete this meeting?", title, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => remove.mutate(undefined, { onSuccess: () => router.back(), onError: setError }) },
    ]);

  return (
    <Screen>
      <Title>{editing ? "Edit meeting" : "Add meeting"}</Title>
      <Field label="Title" value={title} onChangeText={setTitle} placeholder="Site review – Whitefield" />
      <BigButton label={`📅 ${when.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}`} variant="secondary" onPress={() => pick("date")} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Chip label="At a time" selected={!allDay} onPress={() => setAllDay(false)} />
        <Chip label="All day" selected={allDay} onPress={() => setAllDay(true)} />
      </View>
      {!allDay && (
        <>
          <BigButton label={`🕐 ${hm(when)}`} variant="secondary" onPress={() => pick("time")} />
          <Body muted>How long?</Body>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {[15, 30, 60, 90, 120, 180].map((m) => (
              <Chip key={m} label={m < 60 ? `${m} min` : `${m / 60} h`} selected={duration === m} onPress={() => setDuration(m)} />
            ))}
          </View>
        </>
      )}
      <Field label="Location (optional)" value={location} onChangeText={setLocation} placeholder="Whitefield site office" />
      {error != null && <ErrorBox message={(error as Error).message} hint={error instanceof ApiRequestError ? error.hint : undefined} />}
      <BigButton label="Save" onPress={submit} loading={save.isPending} disabled={!title.trim()} />
      <BigButton label="Cancel" variant="secondary" onPress={() => router.back()} />
      {editing && <BigButton label="Delete meeting" variant="danger" onPress={confirmRemove} loading={remove.isPending} />}
    </Screen>
  );
}
