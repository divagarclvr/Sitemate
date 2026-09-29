import { router, useLocalSearchParams } from "expo-router";
import { Pressable, Text } from "react-native";
import { StatusBadge } from "@/components/pickers";
import { BigButton, Body, Card, ErrorBox, Screen, Title } from "@/components/ui";
import { CONTACTS_ROUTE, confirmAndDial } from "@/lib/calls";
import { useContact } from "@/lib/queries";
import { sizes, useTheme } from "@/theme";

export default function ContactScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const q = useContact(id);
  const c = q.data;

  return (
    <Screen>
      <BigButton label="‹ Back" variant="secondary" onPress={() => (router.canGoBack() ? router.back() : router.navigate(CONTACTS_ROUTE))} />
      {q.error && <ErrorBox message={(q.error as Error).message} />}
      {c && (
        <>
          <Title>{c.name}</Title>
          {(c.company || c.role) && <Body muted>{[c.company, c.role].filter(Boolean).join(" · ")}</Body>}
          {c.project_names.length > 0 && <Body>Projects: {c.project_names.join(", ")}</Body>}

          {c.phones.map((ph) => (
            <BigButton key={ph} label={`📞 Call ${ph}`} onPress={() => confirmAndDial(c, ph)} />
          ))}
          <BigButton
            label="🎙️ Voice note about this person"
            variant="secondary"
            onPress={() => router.navigate({ pathname: "/record", params: { contactId: c.id, contactName: c.name, mode: "voice_memo" } })}
          />
          <BigButton label="Edit contact" variant="secondary" onPress={() => router.push({ pathname: "/contacts/edit", params: { id: c.id } })} />

          {c.open_tasks.length > 0 && (
            <Card>
              <Body muted>Open action items for {c.name.split(" ")[0]}</Body>
              {c.open_tasks.map((task) => (
                <Pressable key={task.id} onPress={() => task.note_id && router.push({ pathname: "/note/[id]", params: { id: task.note_id } })}>
                  <Body>
                    ☐ {task.title}
                    {task.due_date ? ` — due ${new Date(task.due_date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : ""}
                  </Body>
                </Pressable>
              ))}
            </Card>
          )}

          <Card>
            <Body muted>Calls, meetings and files</Body>
            {c.notes_list.length === 0 && <Body muted>Nothing yet.</Body>}
            {c.notes_list.map((n) => (
              <Pressable key={n.id} onPress={() => router.push({ pathname: "/note/[id]", params: { id: n.id } })} style={{ gap: 4, paddingVertical: 6 }}>
                <Text style={{ color: t.primary, fontSize: sizes.font, fontWeight: "600" }}>
                  {n.kind === "call" ? "📞 " : ""}
                  {n.title ?? "Note"}
                </Text>
                <Text style={{ color: t.muted, fontSize: 14 }}>
                  {n.started_at ? new Date(n.started_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : ""}
                </Text>
                {n.status !== "done" && <StatusBadge status={n.status} />}
              </Pressable>
            ))}
          </Card>
          {c.notes && (
            <Card>
              <Body muted>Notes</Body>
              <Body>{c.notes}</Body>
            </Card>
          )}
        </>
      )}
    </Screen>
  );
}
