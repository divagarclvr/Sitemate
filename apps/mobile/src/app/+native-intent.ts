import { getShareExtensionKey } from "expo-share-intent";

/**
 * When Android opens SiteMate from the Share menu, send it to the "Save to SiteMate" screen
 * (the root layout then reads the shared files with useShareIntentContext).
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (path.includes(`dataUrl=${getShareExtensionKey()}`)) return "/share";
    return path;
  } catch {
    return "/";
  }
}
