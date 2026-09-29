import type { LanguageHint, NoteListItem } from "@sitemate/shared";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useShareIntentContext } from "expo-share-intent";
import { useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Chip, LanguagePicker, ProjectPicker } from "@/components/pickers";
import { BigButton, Body, Card, ErrorBox, Screen, Title } from "@/components/ui";
import { api, ApiRequestError } from "@/lib/api";
import { newLocalId } from "@/lib/ids";
import { keys, useNotes } from "@/lib/queries";
import { describeSize, fileIcon, incoming } from "@/offline/incoming";
import { processUploads, queueFile } from "@/offline/uploads";
import { sizes, useTheme } from "@/theme";

const isAudio = (name: string, mime: string | null) =>
  (mime ?? "").startsWith("audio/") || /\.(opus|ogg|mp3|m4a|wav|aac|amr)$/i.test(name);

export default function ShareScreen() {
  const t = useTheme();
  const qc = useQueryClient();
  const data = useSyncExternalStore(incoming.subscribe, incoming.get);
  const { resetShareIntent } = useShareIntentContext();
  const notes = useNotes();

  const [projectId, setProjectId] = useState<string | null>(null);
  const [relatedId, setRelatedId] = useState<string | null>(null);
  const [showMeetings, setShowMeetings] = useState(false);
  const [language, setLanguage] = useState<LanguageHint>("auto");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);

  const meetings = (notes.data ?? []).filter((n) => n.kind === "meeting" || n.kind === "call").slice(0, 15);
  const related = meetings.find((m) => m.id === relatedId);

  const close = () => {
    incoming.set(null);
    resetShareIntent();
    router.navigate("/notes");
  };

  const save = async () => {
    if (!data) return;
    setSaving(true);
    setError(null);
    try {
      for (const f of data.files) {
        await queueFile({
          localId: newLocalId(),
          sourceUri: f.uri,
          fileName: f.name,
          mime: f.mime,
          projectId,
          relatedNoteId: relatedId,
          languageHint: language,
        });
      }
      if (data.text?.trim() && data.files.length === 0) {
        await api("/v1/memos/text", {
          method: "POST",
          body: JSON.stringify({ local_id: newLocalId(), text: data.text.trim(), project_id: projectId }),
        });
        void qc.invalidateQueries({ queryKey: keys.notes });
      }
      void processUploads();
      close();
    } catch (e) {
      setError(e instanceof ApiRequestError ? { message: e.message, hint: e.hint } : { message: "Couldn't save.", hint: String(e) });
    } finally {
      setSaving(false);
    }
  };

  if (!data || (data.files.length === 0 && !data.text)) {
    return (
      <Screen>
        <Title>Nothing to save</Title>
        <Body muted>Share a file to SiteMate from WhatsApp, Gmail or Files, or use “Add file” on the Notes screen.</Body>
        <BigButton label="Go to Notes" onPress={close} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>Save to SiteMate</Title>

      <Card>
        {data.files.map((f) => (
          <View key={f.uri} style={styles.fileRow}>
            <Text style={{ fontSize: 28 }}>{fileIcon(f.name, f.mime)}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontSize: sizes.font, fontWeight: "600" }} numberOfLines={2}>
                {f.name}
              </Text>
              <Text style={{ color: t.muted, fontSize: 14 }}>{describeSize(f.size)}</Text>
            </View>
          </View>
        ))}
        {data.files.length === 0 && data.text ? <Body>{data.text}</Body> : null}
      </Card>

      <ProjectPicker value={projectId} onChange={setProjectId} />

      <Card>
        <Body muted>Attach to a meeting (optional)</Body>
        <Pressable onPress={() => setShowMeetings((v) => !v)} accessibilityRole="button">
          <Text style={{ color: t.text, fontSize: sizes.font + 1, fontWeight: "600" }}>
            {related ? related.title ?? "Meeting" : "Not attached — tap to choose"}
          </Text>
        </Pressable>
        {showMeetings && (
          <View style={{ gap: 8 }}>
            <Chip label="Don't attach" selected={!relatedId} onPress={() => (setRelatedId(null), setShowMeetings(false))} />
            {meetings.map((m: NoteListItem) => (
              <Chip
                key={m.id}
                selected={m.id === relatedId}
                onPress={() => (setRelatedId(m.id), setShowMeetings(false))}
                label={`${m.title ?? "Meeting"} · ${m.started_at ? new Date(m.started_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : ""}`}
              />
            ))}
            {meetings.length === 0 && <Body muted>No recent meetings.</Body>}
          </View>
        )}
      </Card>

      {data.files.some((f) => isAudio(f.name, f.mime)) && (
        <Card>
          <Body muted>Language of the voice note</Body>
          <LanguagePicker value={language} onChange={setLanguage} />
        </Card>
      )}

      {error && <ErrorBox message={error.message} hint={error.hint} />}
      <BigButton
        label={data.files.length > 1 ? `Save ${data.files.length} files` : data.files.length ? "Save file" : "Save as memo"}
        onPress={save}
        loading={saving}
      />
      <BigButton label="Cancel" variant="secondary" onPress={close} disabled={saving} />
      <Body muted>
        SiteMate keeps the original file and makes a note from it: summary, amounts, action items. Works offline — it uploads when there is internet.
      </Body>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fileRow: { flexDirection: "row", gap: 12, alignItems: "center" },
});
