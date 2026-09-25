import { useColorScheme } from "react-native";

export interface Theme {
  bg: string;
  card: string;
  text: string;
  muted: string;
  border: string;
  primary: string;
  onPrimary: string;
  danger: string;
  success: string;
}

const light: Theme = {
  bg: "#F4F6FA",
  card: "#FFFFFF",
  text: "#0E1726",
  muted: "#4A5568",
  border: "#D5DBE5",
  primary: "#0B5FFF",
  onPrimary: "#FFFFFF",
  danger: "#C62828",
  success: "#1B7F3B",
};

const dark: Theme = {
  bg: "#0B0F17",
  card: "#151B26",
  text: "#F1F4F9",
  muted: "#A9B4C4",
  border: "#2A3342",
  primary: "#5B93FF",
  onPrimary: "#0B0F17",
  danger: "#FF6B6B",
  success: "#4CD181",
};

/** Maximum contrast for reading on site in direct sunlight (chosen in Settings later). */
export const sunlight: Theme = {
  bg: "#FFFFFF",
  card: "#FFFFFF",
  text: "#000000",
  muted: "#1F1F1F",
  border: "#000000",
  primary: "#0033CC",
  onPrimary: "#FFFFFF",
  danger: "#B00000",
  success: "#006B1F",
};

export const sizes = {
  /** Minimum tap target (dp) — big enough for one-handed use with gloves. */
  tap: 56,
  font: 18,
  fontLarge: 24,
  radius: 14,
  gap: 16,
};

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}
