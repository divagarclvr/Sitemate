import type { ContactCandidate, ResolveContactResponse } from "@sitemate/shared";
import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import { File } from "expo-file-system";
import { useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SPEECH_RECORDING } from "@/audio/recording";
import { api, ApiRequestError } from "@/lib/api";
import { dial } from "@/lib/calls";
import { sizes, useTheme } from "@/theme";
import { BigButton, Body, ErrorBox, Title } from "./ui";

/**
 * "Call Ramesh from the steel vendor" — typed or spoken. SiteMate finds the contact and
 * ALWAYS shows a confirmation with the number before opening the dialer.
 */
export function CallCommand() {
  const t = useTheme();
  const recorder = useAudioRecorder(SPEECH_RECORDING);
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [result, setResult] = useState<ResolveContactResponse | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resolve = async (utterance: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<ResolveContactResponse>("/v1/contacts/resolve", { method: "POST", body: JSON.stringify({ utterance }) });
      if (!r.candidates.length) setError({ message: `No contact found for “${utterance}”.`, hint: "Import your phone contacts or add the person first." });
      else setResult(r);
    } catch (e) {
      setError(e instanceof ApiRequestError ? { message: e.message, hint: e.hint } : { message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const startListening = async () => {
    setError(null);
    const p = await requestRecordingPermissionsAsync();
    if (!p.granted) return setError({ message: "Microphone permission is off.", hint: "Allow it in phone Settings → Apps → SiteMate." });
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: false });
    await recorder.prepareToRecordAsync();
    recorder.record();
    setListening(true);
    timer.current = setTimeout(() => void stopListening(), 8000); // voice commands are short
  };

  const stopListening = async () => {
    if (timer.current) clearTimeout(timer.current);
    setListening(false);
    setBusy(true);
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
      if (!recorder.uri) throw new Error("No audio recorded");
      const f = new File(recorder.uri);
      const audio_base64 = await f.base64();
      f.delete();
      const r = await api<{ text: string }>("/v1/voice/transcribe", { method: "POST", body: JSON.stringify({ audio_base64, mime: "audio/mp4" }) });
      setText(r.text);
      await resolve(r.text);
    } catch (e) {
      setBusy(false);
      setError(e instanceof ApiRequestError ? { message: e.message, hint: e.hint } : { message: String(e) });
    }
  };

  const call = async (c: ContactCandidate, phone: string) => {
    setResult(null);
    await dial(c.contact, phone);
  };

  return (
    <View style={{ gap: 10 }}>
      <View style={styles.row}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Who to call? e.g. Ramesh steel vendor"
          placeholderTextColor={t.muted}
          returnKeyType="search"
          onSubmitEditing={() => text.trim() && resolve(text)}
          style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.card }]}
        />
        <Pressable
          onPress={listening ? stopListening : startListening}
          accessibilityRole="button"
          accessibilityLabel={listening ? "Stop listening" : "Say who to call"}
          style={[styles.mic, { backgroundColor: listening ? t.danger : t.primary }]}
        >
          <Text style={{ color: "#fff", fontSize: 24 }}>{listening ? "■" : "🎤"}</Text>
        </Pressable>
      </View>
      {listening && <Body>Listening… say e.g. “Call Ramesh from the steel vendor”. Tap ■ when done.</Body>}
      <BigButton label="Find and call" onPress={() => resolve(text)} disabled={!text.trim() || listening} loading={busy} />
      {error && <ErrorBox message={error.message} hint={error.hint} />}

      <Modal visible={!!result} transparent animationType="slide" onRequestClose={() => setResult(null)}>
        <View style={styles.backdrop}>
          <ScrollView style={[styles.sheet, { backgroundColor: t.card }]} contentContainerStyle={{ gap: 12, paddingBottom: 32 }}>
            <Title>Confirm call</Title>
            <Body muted>“{result?.query}”</Body>
            {result?.candidates.map((c, i) => (
              <View key={c.contact.id} style={[styles.cand, { borderColor: i === 0 ? t.primary : t.border }]}>
                <Text style={{ color: t.text, fontSize: sizes.font + 2, fontWeight: "800" }}>{c.contact.name}</Text>
                <Body muted>{[c.contact.company, c.contact.role].filter(Boolean).join(" · ") || c.reason}</Body>
                {c.contact.phones.map((ph) => (
                  <BigButton key={ph} label={`📞 Call ${ph}`} variant={i === 0 ? "primary" : "secondary"} onPress={() => void call(c, ph)} />
                ))}
              </View>
            ))}
            <BigButton label="Cancel" variant="secondary" onPress={() => setResult(null)} />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: { flex: 1, minHeight: sizes.tap, borderWidth: 1, borderRadius: sizes.radius, paddingHorizontal: 14, fontSize: sizes.font },
  mic: { width: sizes.tap, height: sizes.tap, borderRadius: sizes.tap / 2, alignItems: "center", justifyContent: "center" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { maxHeight: "85%", padding: sizes.gap, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  cand: { borderWidth: 2, borderRadius: sizes.radius, padding: 12, gap: 8 },
});
