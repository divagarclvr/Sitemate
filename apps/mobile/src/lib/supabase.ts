import "expo-sqlite/localStorage/install";
import { createClient } from "@supabase/supabase-js";
import { AppState } from "react-native";
import { config } from "./config";

export const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: {
    storage: localStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Refresh the login token only while the app is on screen (saves battery).
AppState.addEventListener("change", (state) => {
  if (state === "active") supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
