import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { router, Stack } from "expo-router";
import { ShareIntentProvider, useShareIntentContext } from "expo-share-intent";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { ActivityIndicator, AppState, View } from "react-native";
import { AuthProvider, useAuth } from "@/lib/auth";
import { startCallNotesPrompt } from "@/lib/calls";
import { rescheduleReminders } from "@/lib/notifications";
import { keys, todayKey, useToday } from "@/lib/queries";
import { incoming } from "@/offline/incoming";
import { setOnUploaded, startUploadTriggers } from "@/offline/uploads";
import { useTheme } from "@/theme";

const queryClient = new QueryClient();

/** Keeps phone reminders in step with your calendar and tasks: whenever Today refreshes, or the app is opened. */
function RemindersSync() {
  const today = useToday();
  useEffect(() => {
    if (today.data) void rescheduleReminders(today.data).catch(() => undefined);
  }, [today.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void queryClient.invalidateQueries({ queryKey: todayKey });
    });
    // Tapping a reminder opens Today.
    const tap = Notifications.addNotificationResponseReceivedListener(() => router.navigate("/"));
    return () => {
      sub.remove();
      tap.remove();
    };
  }, []);
  return null;
}

function RootNavigator() {
  const { session, loading } = useAuth();
  const { hasShareIntent, shareIntent } = useShareIntentContext();
  const t = useTheme();

  // Once signed in, keep uploading saved recordings and files whenever there is internet.
  useEffect(() => {
    if (!session) return;
    setOnUploaded(() => void queryClient.invalidateQueries({ queryKey: keys.notes }));
    const stopUploads = startUploadTriggers();
    const stopCallPrompt = startCallNotesPrompt();
    return () => {
      stopUploads();
      stopCallPrompt();
    };
  }, [session]);

  // Something was shared to SiteMate (from WhatsApp, Gmail, Files…) → "Save to SiteMate" screen.
  // If not signed in yet, this runs again right after login.
  useEffect(() => {
    if (!session || !hasShareIntent) return;
    incoming.set({
      source: "share",
      text: shareIntent.text ?? shareIntent.webUrl ?? null,
      files: (shareIntent.files ?? []).map((f) => ({ uri: f.path, name: f.fileName || "shared file", mime: f.mimeType || null, size: f.size })),
    });
    router.navigate("/share");
  }, [session, hasShareIntent, shareIntent]);

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.bg }}>
        <ActivityIndicator size="large" color={t.primary} />
      </View>
    );
  }

  return (
    <>
    {session && <RemindersSync />}
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }}>
      <Stack.Protected guard={!!session}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="note/[id]" />
        <Stack.Screen name="share" />
        <Stack.Screen name="contacts/index" />
        <Stack.Screen name="contacts/[id]" />
        <Stack.Screen name="contacts/edit" />
        <Stack.Screen name="calendar/index" />
        <Stack.Screen name="calendar/event" />
      </Stack.Protected>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
    </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <ShareIntentProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <StatusBar style="auto" />
          <RootNavigator />
        </AuthProvider>
      </QueryClientProvider>
    </ShareIntentProvider>
  );
}
