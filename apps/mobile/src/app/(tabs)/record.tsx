import type { LanguageHint } from "@sitemate/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  requestNotificationPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ConsentSheet, Chip, LanguagePicker, ProjectPicker } from "@/components/pickers";
import { BigButton, Body, Card, ErrorBox, Screen, Title } from "@/components/ui";
import { hasOwnRecordingService, startRecordingService, stopRecordingService } from "@/audio/foregroundService";
import { formatDuration, SPEECH_RECORDING } from "@/audio/recording";
import { api, ApiRequestError } from "@/lib/api";
import { newLocalId } from "@/lib/ids";
import { keys } from "@/lib/queries";
import { queueRecording } from "@/offline/uploads";
import { sizes, useTheme } from "@/theme";

const KEEP_AWAKE_TAG = "recording";

type Mode = "meeting" | "voice_memo" | "text_memo";
type Phase = "idle" | "recording" | "paused" | "saving";

export default function RecordScreen() {
  const t = useTheme();
  const qc = useQueryClient();
  const recorder = useAudioRecorder(SPEECH_RECORDING);

  const [mode, setMode] = useState<Mode>("meeting");
  const [language, setLanguage] = useState<LanguageHint>("auto");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [consentOpen, setConsentOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [memoText, setMemoText] = useState("");
  const [memoSaving, setMemoSaving] = useState(false);
  const startedAt = useRef<Date | null>(null);
  const blockedByPhone = useRef(false);
  const ownService = useRef(false);
  const localId = useRef<string>("");

  // Timer + sound level while recording.
  useEffect(() => {
    if (phase !== "recording" && phase !== "paused") return;
    const id = setInterval(() => {
      const s = recorder.getStatus();
      setElapsed(s.durationMillis);
      // metering is in dB (≈ -60 quiet … 0 loud) → 0..1
      setLevel(s.metering != null ? Math.max(0, Math.min(1, (s.metering + 60) / 60)) : 0);
    }, 300);
    return () => clearInterval(id);
  }, [phase, recorder]);

  const askToStart = async () => {
    setError(null);
    setWarning(null);
    const mic = await requestRecordingPermissionsAsync();
    if (!mic.granted) {
      setError({ message: "Microphone permission is off.", hint: "Open phone Settings → Apps → SiteMate → Permissions → Microphone → Allow." });
      return;
    }
    if (mode === "meeting") setConsentOpen(true);
    else void start();
  };

  /** Android with our own service: record in the foreground, then keep it going via startForegroundService. */
  const startWithOwnService = async (notificationsOk: boolean) => {
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: false });
    await recorder.prepareToRecordAsync();
    recorder.record();
    if (!notificationsOk) return false;
    try {
      await startRecordingService(mode === "meeting" ? "Recording meeting" : "Recording voice memo");
      // The service keeps the microphone allowed; tell expo-audio not to pause when the screen locks.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: true });
      ownService.current = true;
      return true;
    } catch (e) {
      console.warn("[record] SiteMate recording service refused:", errorText(e));
      blockedByPhone.current = true;
      return false;
    }
  };

  /** Older app builds / iOS: expo-audio's own background service, falling back to foreground-only. */
  const startWithExpoService = async (notificationsOk: boolean) => {
    const begin = async (withBackground: boolean) => {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: withBackground });
      await recorder.prepareToRecordAsync();
      await recordWhenServiceReady(recorder);
    };
    try {
      await begin(notificationsOk);
      return notificationsOk;
    } catch (e) {
      // Some phones (e.g. Vivo/iQOO) refuse this service. Record in the foreground instead.
      if (!notificationsOk || !/recording service/i.test(errorText(e))) throw e;
      console.warn("[record] background service refused, recording in foreground:", errorText(e));
      await recorder.stop().catch(() => undefined);
      await begin(false);
      blockedByPhone.current = true;
      return false;
    }
  };

  const start = async () => {
    setConsentOpen(false);
    blockedByPhone.current = false;
    // Recording with the screen locked needs an Android foreground service, which must show a
    // notification — so it needs the notification permission.
    let notificationsOk = true;
    if (Platform.OS === "android") {
      const n = await requestNotificationPermissionsAsync().catch(() => null);
      notificationsOk = !!n?.granted;
    }
    try {
      const background = hasOwnRecordingService
        ? await startWithOwnService(notificationsOk)
        : await startWithExpoService(notificationsOk);
      if (!background) await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
      startedAt.current = new Date();
      localId.current = newLocalId();
      setElapsed(0);
      setPhase("recording");
      if (!background) {
        setWarning(
          blockedByPhone.current
            ? "Your phone blocked recording with the screen locked, so the screen will stay on. Keep SiteMate open (you can turn brightness down). To fix: Settings → Apps → SiteMate → Battery → No restrictions / Allow background activity."
            : "Notifications are off, so the screen will stay on while recording. Keep SiteMate open — or allow notifications in Settings → Apps → SiteMate.",
        );
      }
    } catch (e) {
      console.warn("[record] start failed:", errorText(e)); // appears in the laptop's Expo log
      await recorder.stop().catch(() => undefined); // release the half-started recorder so Retry works
      await endBackground();
      setError({ message: "Couldn't start recording.", hint: `${errorText(e)}. Close other apps using the microphone (calls, WhatsApp voice) and try again.` });
    }
  };

  const togglePause = async () => {
    if (phase === "recording") {
      recorder.pause();
      setPhase("paused");
      return;
    }
    try {
      if (ownService.current) {
        // record() refuses while expo-audio thinks its own service should be used; switch briefly.
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: false });
        recorder.record();
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: true });
      } else {
        recorder.record();
      }
      setPhase("recording");
    } catch (e) {
      setError({ message: "Couldn't resume recording.", hint: errorText(e) });
    }
  };

  /** Stops our service, the screen-on lock and background mode (safe to call any time). */
  const endBackground = async () => {
    ownService.current = false;
    await stopRecordingService();
    await setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false }).catch(() => undefined);
    await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
  };

  // A service left running by an app reload (not a real recording) is stopped when this screen opens.
  useEffect(() => {
    void stopRecordingService();
  }, []);

  const stopAndSave = async () => {
    setPhase("saving");
    try {
      const durationMs = recorder.getStatus().durationMillis;
      await recorder.stop();
      await endBackground();
      if (!recorder.uri) throw new Error("no audio file was produced");
      await queueRecording({
        localId: localId.current,
        tempUri: recorder.uri,
        kind: mode === "meeting" ? "meeting" : "memo",
        languageHint: language,
        projectId,
        startedAt: startedAt.current ?? new Date(),
        durationSec: Math.round(durationMs / 1000),
      });
      setPhase("idle");
      setElapsed(0);
      router.navigate("/notes");
    } catch (e) {
      await endBackground();
      setPhase("idle");
      setError({ message: "Couldn't save the recording.", hint: String(e) });
    }
  };

  const discard = () =>
    Alert.alert("Discard this recording?", "The audio will be deleted and no note will be made.", [
      { text: "Keep recording", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: async () => {
          await recorder.stop().catch(() => undefined);
          await endBackground();
          setPhase("idle");
          setElapsed(0);
        },
      },
    ]);

  const saveTextMemo = async () => {
    setMemoSaving(true);
    setError(null);
    try {
      await api("/v1/memos/text", {
        method: "POST",
        body: JSON.stringify({ local_id: newLocalId(), text: memoText.trim(), project_id: projectId }),
      });
      setMemoText("");
      void qc.invalidateQueries({ queryKey: keys.notes });
      router.navigate("/notes");
    } catch (e) {
      setError(e instanceof ApiRequestError ? { message: e.message, hint: e.hint } : { message: String(e) });
    } finally {
      setMemoSaving(false);
    }
  };

  const busy = phase !== "idle";

  // ─────────── while recording: a focused, glanceable screen ───────────
  if (busy) {
    return (
      <Screen scroll={false}>
        <View style={styles.center}>
          <Text style={[styles.recLabel, { color: phase === "paused" ? t.muted : t.danger }]}>
            {phase === "paused" ? "⏸ Paused" : phase === "saving" ? "Saving…" : "● Recording"}
          </Text>
          <Text style={[styles.timer, { color: t.text }]}>{formatDuration(elapsed)}</Text>
          <View style={[styles.meter, { backgroundColor: t.border }]}>
            <View style={{ width: `${Math.round(level * 100)}%`, height: "100%", backgroundColor: phase === "recording" ? t.success : t.muted }} />
          </View>
          {warning ? <Body>{warning}</Body> : <Body muted>Keeps recording when the screen is locked.</Body>}
        </View>
        <View style={{ gap: 12 }}>
          <BigButton label={phase === "paused" ? "Resume" : "Pause"} variant="secondary" onPress={() => void togglePause()} disabled={phase === "saving"} />
          <BigButton label="Stop and make note" onPress={stopAndSave} loading={phase === "saving"} />
          <BigButton label="Discard" variant="danger" onPress={discard} disabled={phase === "saving"} />
        </View>
      </Screen>
    );
  }

  // ─────────── setup ───────────
  return (
    <Screen>
      <Title>Record</Title>
      <View style={styles.row}>
        <Chip label="Meeting" selected={mode === "meeting"} onPress={() => setMode("meeting")} />
        <Chip label="Voice memo" selected={mode === "voice_memo"} onPress={() => setMode("voice_memo")} />
        <Chip label="Text memo" selected={mode === "text_memo"} onPress={() => setMode("text_memo")} />
      </View>

      <ProjectPicker value={projectId} onChange={setProjectId} />

      {error && <ErrorBox message={error.message} hint={error.hint} />}

      {mode === "text_memo" ? (
        <>
          <TextInput
            value={memoText}
            onChangeText={setMemoText}
            multiline
            placeholder="Type your note — e.g. 'Plumbing vendor agreed to finish Tower 2 risers by 10 Oct, ₹2.4 L balance on completion.'"
            placeholderTextColor={t.muted}
            style={[styles.memo, { color: t.text, borderColor: t.border, backgroundColor: t.card }]}
          />
          <BigButton label="Save memo" onPress={saveTextMemo} loading={memoSaving} disabled={!memoText.trim()} />
        </>
      ) : (
        <>
          <Card>
            <Body muted>Main language spoken</Body>
            <LanguagePicker value={language} onChange={setLanguage} />
            <Body muted>Choosing the language gives a better transcript than Auto when people mix languages.</Body>
          </Card>
          <Pressable
            onPress={askToStart}
            accessibilityRole="button"
            accessibilityLabel="Start recording"
            style={({ pressed }) => [styles.bigRecord, { backgroundColor: t.danger, opacity: pressed ? 0.85 : 1 }]}
          >
            <Text style={styles.bigRecordText}>● Record</Text>
            <Text style={styles.bigRecordSub}>{mode === "meeting" ? "Meeting" : "Voice memo"}</Text>
          </Pressable>
        </>
      )}

      <ConsentSheet visible={consentOpen} onAccept={start} onCancel={() => setConsentOpen(false)} />
    </Screen>
  );
}

type Recorder = ReturnType<typeof useAudioRecorder>;

/**
 * On Android the background-recording service connects a moment after prepareToRecordAsync();
 * record() called too early fails with "service connection is not bound". Retry briefly.
 */
async function recordWhenServiceReady(recorder: Recorder) {
  let last: unknown;
  for (let i = 0; i < 25; i++) {
    try {
      recorder.record();
      return;
    } catch (e) {
      last = e;
      if (!/not bound/i.test(errorText(e))) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw last;
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  recLabel: { fontSize: 24, fontWeight: "800" },
  timer: { fontSize: 72, fontWeight: "800", fontVariant: ["tabular-nums"] },
  meter: { width: "80%", height: 14, borderRadius: 7, overflow: "hidden" },
  bigRecord: {
    alignSelf: "center",
    width: 220,
    height: 220,
    borderRadius: 110,
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 12,
  },
  bigRecordText: { color: "#fff", fontSize: 34, fontWeight: "800" },
  bigRecordSub: { color: "#fff", fontSize: sizes.font, marginTop: 4 },
  memo: { minHeight: 180, borderWidth: 1, borderRadius: sizes.radius, padding: 14, fontSize: sizes.font, textAlignVertical: "top" },
});
