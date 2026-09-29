import type { ContactDto } from "@sitemate/shared";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CallCommand } from "@/components/CallCommand";
import { BigButton, Body, Card, ErrorBox } from "@/components/ui";
import { ApiRequestError } from "@/lib/api";
import { confirmAndDial } from "@/lib/calls";
import { importPhoneContacts } from "@/lib/phoneContacts";
import { useContacts } from "@/lib/queries";
import { sizes, useTheme } from "@/theme";

export default function ContactsScreen() {
  const t = useTheme();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const contacts = useContacts(q);
  const [importing, setImporting] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean; hint?: string } | null>(null);

  const runImport = async () => {
    setMessage(null);
    setImporting("Reading phone contacts…");
    try {
      const r = await importPhoneContacts((n) => setImporting(`Reading phone contacts… ${n}`));
      if (r === "denied") {
        setMessage({ text: "Contacts permission was not given.", error: true, hint: "Allow it in phone Settings → Apps → SiteMate → Permissions → Contacts." });
      } else {
        setMessage({ text: `Imported ${r.with_numbers} contacts with phone numbers (${r.created} new, ${r.updated} updated).` });
        void qc.invalidateQueries({ queryKey: ["contacts"] });
      }
    } catch (e) {
      setMessage({ text: e instanceof ApiRequestError ? e.message : String(e), error: true, hint: e instanceof ApiRequestError ? e.hint : undefined });
    } finally {
      setImporting(null);
    }
  };

  const row = ({ item }: { item: ContactDto }) => (
    <View style={[styles.row, { backgroundColor: t.card, borderColor: t.border }]}>
      <Pressable style={{ flex: 1, gap: 2 }} onPress={() => router.push({ pathname: "/contacts/[id]", params: { id: item.id } })}>
        <Text style={{ color: t.text, fontSize: sizes.font + 1, fontWeight: "700" }} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={{ color: t.muted, fontSize: 15 }} numberOfLines={1}>
          {[item.company, item.role].filter(Boolean).join(" · ") || item.phones[0]}
        </Text>
      </Pressable>
      {item.phones[0] && (
        <Pressable
          onPress={() => confirmAndDial(item, item.phones[0]!)}
          accessibilityRole="button"
          accessibilityLabel={`Call ${item.name}`}
          style={[styles.callBtn, { backgroundColor: t.success }]}
        >
          <Text style={{ fontSize: 22 }}>📞</Text>
        </Pressable>
      )}
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top", "left", "right"]}>
      <FlatList
        data={contacts.data ?? []}
        keyExtractor={(c) => c.id}
        renderItem={row}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: sizes.gap, gap: 10 }}
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 4 }}>
            <BigButton label="‹ Back" variant="secondary" onPress={() => (router.canGoBack() ? router.back() : router.navigate("/more"))} />
            <Text style={[styles.h1, { color: t.text }]}>Contacts</Text>
            <Card>
              <Body muted>Call someone</Body>
              <CallCommand />
            </Card>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <BigButton label={importing ?? "Import phone contacts"} variant="secondary" onPress={runImport} loading={!!importing && false} disabled={!!importing} />
              </View>
              <View style={{ flex: 1 }}>
                <BigButton label="＋ New contact" variant="secondary" onPress={() => router.push("/contacts/edit")} />
              </View>
            </View>
            {message &&
              (message.error ? <ErrorBox message={message.text} hint={message.hint} /> : <Body>{message.text}</Body>)}
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Search name, company, role…"
              placeholderTextColor={t.muted}
              style={[styles.search, { color: t.text, borderColor: t.border, backgroundColor: t.card }]}
            />
            {contacts.error && <ErrorBox message={(contacts.error as Error).message} />}
          </View>
        }
        ListEmptyComponent={
          contacts.isLoading ? null : (
            <Body muted>{q ? "No contacts match." : "No contacts yet. Tap “Import phone contacts” or “New contact”."}</Body>
          )
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  h1: { fontSize: sizes.fontLarge + 4, fontWeight: "800" },
  search: { minHeight: 50, borderWidth: 1, borderRadius: sizes.radius, paddingHorizontal: 14, fontSize: sizes.font },
  row: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: sizes.radius, padding: 12, minHeight: sizes.tap + 8 },
  callBtn: { width: sizes.tap, height: sizes.tap, borderRadius: sizes.tap / 2, alignItems: "center", justifyContent: "center" },
});
