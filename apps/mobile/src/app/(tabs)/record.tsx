import type { LanguageHint } from "@sitemate/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  requestNotificationPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ConsentSheet, Chip, LanguagePicker, ProjectPicker } from "@/components/pickers";
import { BigButton, Body, Card, ErrorBox, Screen, Title } from "@/components/ui";
import { formatDuration, SPEECH_RECORDING } from "@/audio/recording";
import { api, ApiRequestError } from "@/lib/api";
import { newLocalId } from "@/lib/ids";
import { keys } from "@/lib/queries";
import { queueRecording } from "@/offline/uploads";
import { sizes, useTheme } from "@/theme";

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
  const [memoText, setMemoText] = useState("");
  const [memoSaving, setMemoSaving] = useState(false);
  const startedAt = useRef<Date | null>(null);
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
    const mic = await requestRecordingPermissionsAsync();
    if (!mic.granted) {
      setError({ message: "Microphone permission is off.", hint: "Open phone Settings → Apps → SiteMate → Permissions → Microphone → Allow." });
      return;
    }
    // Android shows a "Recording" notification while the screen is locked; it needs this permission.
    if (Platform.OS === "android") await requestNotificationPermissionsAsync().catch(() => undefined);
    if (mode === "meeting") setConsentOpen(true);
    else void start();
  };

  const start = async () => {
    setConsentOpen(false);
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      startedAt.current = new Date();
      localId.current = newLocalId();
      setElapsed(0);
      setPhase("recording");
    } catch (e) {
      setError({ message: "Couldn't start recording.", hint: `${String(e)}. Close other apps using the microphone and try again.` });
    }
  };

  const togglePause = () => {
    if (phase === "recording") {
      recorder.pause();
      setPhase("paused");
    } else {
      recorder.record();
      setPhase("recording");
    }
  };

  const stopAndSave = async () => {
    setPhase("saving");
    try {
      const durationMs = recorder.getStatus().durationMillis;
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false });
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
          await setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false });
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
          <Body muted>Keeps recording when the screen is locked.</Body>
        </View>
        <View style={{ gap: 12 }}>
          <BigButton label={phase === "paused" ? "Resume" : "Pause"} variant="secondary" onPress={togglePause} disabled={phase === "saving"} />
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
