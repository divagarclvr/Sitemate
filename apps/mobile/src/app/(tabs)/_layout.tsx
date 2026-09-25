import Ionicons from "@expo/vector-icons/Ionicons";
import { Tabs } from "expo-router";
import type { ComponentProps } from "react";
import type { ColorValue } from "react-native";
import { sizes, useTheme } from "@/theme";

type IconName = ComponentProps<typeof Ionicons>["name"];

const icon =
  (name: IconName) =>
  ({ color }: { color: ColorValue }) => <Ionicons name={name} size={28} color={color} />;

export default function TabsLayout() {
  const t = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.primary,
        tabBarInactiveTintColor: t.muted,
        tabBarStyle: { backgroundColor: t.card, borderTopColor: t.border, height: sizes.tap + 24 },
        tabBarLabelStyle: { fontSize: 13, fontWeight: "600" },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Today", tabBarIcon: icon("today") }} />
      <Tabs.Screen name="record" options={{ title: "Record", tabBarIcon: icon("mic-circle") }} />
      <Tabs.Screen name="notes" options={{ title: "Notes", tabBarIcon: icon("document-text") }} />
      <Tabs.Screen name="chat" options={{ title: "Chat", tabBarIcon: icon("chatbubbles") }} />
      <Tabs.Screen name="more" options={{ title: "More", tabBarIcon: icon("menu") }} />
    </Tabs>
  );
}
