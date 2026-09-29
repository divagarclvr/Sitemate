import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Two apps can live side by side on the phone:
 *  - "SiteMate"      (preview/production builds, server online) — package app.sitemate.personal
 *  - "SiteMate Dev"  (development build that loads code from the laptop) — package app.sitemate.personal.dev
 * Everything else comes from app.json.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const isDev = process.env.APP_VARIANT === "development";
  return {
    ...(config as ExpoConfig),
    name: isDev ? "SiteMate Dev" : "SiteMate",
    android: {
      ...config.android,
      package: isDev ? "app.sitemate.personal.dev" : "app.sitemate.personal",
    },
    ios: {
      ...config.ios,
      bundleIdentifier: isDev ? "app.sitemate.personal.dev" : "app.sitemate.personal",
    },
  };
};
