import type { NoteListItem } from "@sitemate/shared";
import { getDocumentAsync } from "expo-document-picker";
import { router } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBadge } from "@/components/pickers";
import { BigButton } from "@/components/ui";
import { Body, ErrorBox } from "@/components/ui";
import { formatDuration } from "@/audio/recording";
import { ApiRequestError } from "@/lib/api";
import { useNotes } from "@/lib/queries";
import { fileIcon, incoming } from "@/offline/incoming";
import { processUploads, uploadQueue } from "@/offline/uploads";
import { sizes, useTheme } from "@/theme";

function when(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export default function NotesScreen() {
  const t = useTheme();
  const notes = useNotes();
  const pending = useSyncExternalStore(uploadQueue.subscribe, uploadQueue.get);
  const [q, setQ] = useState("");

  // Uploads finishing → refresh the list.
  useEffect(() => {
    void notes.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.length]);

  const addFiles = async () => {
    const r = await getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: "*/*" });
    if (r.canceled || !r.assets?.length) return;
    incoming.set({
      source: "picker",
      text: null,
      files: r.assets.map((a) => ({ uri: a.uri, name: a.name, mime: a.mimeType ?? null, size: a.size ?? null })),
    });
    router.push("/share");
  };

  const shown = (notes.data ?? []).filter((n) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return [n.title, n.summary, n.project_name].some((x) => x?.toLowerCase().includes(s));
  });

  const renderNote = ({ item }: { item: NoteListItem }) => (
    <Pressable
      onPress={() => router.push({ pathname: "/note/[id]", params: { id: item.id } })}
      style={({ pressed }) => [styles.card, { backgroundColor: t.card, borderColor: t.border, opacity: pressed ? 0.8 : 1 }]}
    >
      <View style={styles.rowBetween}>
        <StatusBadge status={item.status} />
        <Text style={{ color: t.muted, fontSize: 14 }}>
          {when(item.started_at)}
          {item.duration_sec ? ` · ${formatDuration(item.duration_sec * 1000)}` : ""}
        </Text>
      </View>
      <Text style={[styles.title, { color: t.text }]} numberOfLines={2}>
        {item.title ?? (item.kind === "memo" ? "Memo" : "Meeting") + " — processing"}
      </Text>
      {item.project_name && <Text style={{ color: t.primary, fontWeight: "600" }}>{item.project_name}</Text>}
      {item.status === "done" && item.summary ? (
        <Text style={{ color: t.muted, fontSize: 16 }} numberOfLines={2}>{item.summary}</Text>
      ) : item.progress_text || item.error_message ? (
        <Text style={{ color: item.status === "failed" ? t.danger : t.muted, fontSize: 16 }}>{item.error_message ?? item.progress_text}</Text>
      ) : null}
      {item.open_tasks > 0 && <Text style={{ color: t.text, fontWeight: "600" }}>☐ {item.open_tasks} open action item{item.open_tasks > 1 ? "s" : ""}</Text>}
    </Pressable>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top", "left", "right"]}>
      <FlatList
        data={shown}
        keyExtractor={(n) => n.id}
        renderItem={renderNote}
        contentContainerStyle={{ padding: sizes.gap, gap: 12 }}
        refreshControl={<RefreshControl refreshing={notes.isRefetching} onRefresh={() => { void processUploads(); void notes.refetch(); }} />}
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            <Text style={[styles.h1, { color: t.text }]}>Notes</Text>
            <BigButton label="＋ Add file (PDF, Excel, photo, audio…)" variant="secondary" onPress={addFiles} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Search notes"
              placeholderTextColor={t.muted}
              style={[styles.search, { color: t.text, borderColor: t.border, backgroundColor: t.card }]}
            />
            {pending.map((p) => (
              <View key={p.local_id} style={[styles.card, { backgroundColor: t.card, borderColor: t.border }]}>
                <View style={styles.rowBetween}>
                  <StatusBadge status={p.status === "uploading" ? "uploading" : "local"} />
                  <Text style={{ color: t.muted, fontSize: 14 }}>
                    {when(p.started_at)}
                    {p.upload_type === "file" ? "" : ` · ${formatDuration((p.duration_sec ?? 0) * 1000)}`}
                  </Text>
                </View>
                <Text style={[styles.title, { color: t.text }]} numberOfLines={2}>
                  {p.upload_type === "file" ? `${fileIcon(p.file_name ?? "", p.mime)} ${p.file_name ?? "File"}` : p.kind === "memo" ? "Voice memo" : "Meeting recording"}
                </Text>
                <Text style={{ color: p.status === "failed" ? t.danger : t.muted, fontSize: 16 }}>
                  {p.status === "uploading"
                    ? "Uploading…"
                    : p.last_error
                      ? `Waiting to upload — ${p.last_error}. Will retry automatically.`
                      : "Waiting for internet — will upload automatically."}
                </Text>
              </View>
            ))}
            {notes.error && (
              <ErrorBox
                message={notes.error.message}
                hint={notes.error instanceof ApiRequestError ? notes.error.hint : undefined}
              />
            )}
          </View>
        }
        ListEmptyComponent={
          notes.isLoading ? null : (
            <Body muted>{q ? "No notes match your search." : "No notes yet. Go to Record to capture your first meeting."}</Body>
          )
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  h1: { fontSize: sizes.fontLarge + 4, fontWeight: "800" },
  search: { minHeight: 50, borderWidth: 1, borderRadius: sizes.radius, paddingHorizontal: 14, fontSize: sizes.font },
  card: { borderWidth: 1, borderRadius: sizes.radius, padding: 14, gap: 6 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: sizes.font + 1, fontWeight: "700" },
});
