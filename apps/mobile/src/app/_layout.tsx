import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { ShareIntentProvider, useShareIntentContext } from "expo-share-intent";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { AuthProvider, useAuth } from "@/lib/auth";
import { keys } from "@/lib/queries";
import { incoming } from "@/offline/incoming";
import { setOnUploaded, startUploadTriggers } from "@/offline/uploads";
import { useTheme } from "@/theme";

const queryClient = new QueryClient();

function RootNavigator() {
  const { session, loading } = useAuth();
  const { hasShareIntent, shareIntent } = useShareIntentContext();
  const t = useTheme();

  // Once signed in, keep uploading saved recordings and files whenever there is internet.
  useEffect(() => {
    if (!session) return;
    setOnUploaded(() => void queryClient.invalidateQueries({ queryKey: keys.notes }));
    return startUploadTriggers();
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
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }}>
      <Stack.Protected guard={!!session}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="note/[id]" />
        <Stack.Screen name="share" />
      </Stack.Protected>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
    </Stack>
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
