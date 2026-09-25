import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { sizes, useTheme } from "@/theme";

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const t = useTheme();
  const inner = <View style={styles.inner}>{children}</View>;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top", "left", "right"]}>
      {scroll ? <ScrollView keyboardShouldPersistTaps="handled">{inner}</ScrollView> : inner}
    </SafeAreaView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={[styles.title, { color: t.text }]}>{children}</Text>;
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const t = useTheme();
  return <Text style={[styles.body, { color: muted ? t.muted : t.text }]}>{children}</Text>;
}

export function Card({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }]}>{children}</View>;
}

export function BigButton(props: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
}) {
  const t = useTheme();
  const { variant = "primary" } = props;
  const bg = variant === "primary" ? t.primary : variant === "danger" ? t.danger : t.card;
  const fg = variant === "secondary" ? t.text : t.onPrimary;
  const disabled = props.disabled || props.loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: t.border, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
      ]}
    >
      {props.loading ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{props.label}</Text>}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const t = useTheme();
  const { label, style, ...rest } = props;
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.label, { color: t.muted }]}>{label}</Text>
      <TextInput
        placeholderTextColor={t.muted}
        {...rest}
        style={[styles.input, { color: t.text, backgroundColor: t.card, borderColor: t.border }, style]}
      />
    </View>
  );
}

export function ErrorBox({ message, hint }: { message: string; hint?: string }) {
  const t = useTheme();
  return (
    <View style={[styles.card, { borderColor: t.danger, backgroundColor: t.card }]}>
      <Text style={[styles.body, { color: t.danger, fontWeight: "700" }]}>{message}</Text>
      {hint ? <Text style={[styles.body, { color: t.text }]}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  inner: { padding: sizes.gap, gap: sizes.gap },
  title: { fontSize: sizes.fontLarge + 4, fontWeight: "800" },
  body: { fontSize: sizes.font, lineHeight: sizes.font * 1.4 },
  card: { borderWidth: 1, borderRadius: sizes.radius, padding: sizes.gap, gap: 8 },
  button: {
    minHeight: sizes.tap,
    borderRadius: sizes.radius,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  buttonText: { fontSize: sizes.font + 1, fontWeight: "700" },
  label: { fontSize: sizes.font - 2, fontWeight: "600" },
  input: { minHeight: sizes.tap, borderWidth: 1, borderRadius: sizes.radius, paddingHorizontal: 14, fontSize: sizes.font + 2 },
});
