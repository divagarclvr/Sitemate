/**
 * Public settings only. These come from apps/mobile/.env (EXPO_PUBLIC_*), are built into
 * the app, and are safe to ship. NEVER put AI or other secret keys here.
 */
export const config = {
  apiBaseUrl: (process.env.EXPO_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, ""),
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? "",
  supabaseKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
};

export const missingConfig = Object.entries(config)
  .filter(([, v]) => !v)
  .map(([k]) => k);
