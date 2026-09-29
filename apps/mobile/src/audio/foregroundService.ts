import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

interface SitemateRecorderModule {
  startForegroundService(text: string): Promise<boolean>;
  stopForegroundService(): Promise<boolean>;
  isRunning(): boolean;
}

/**
 * Our own Android "microphone" foreground service (modules/sitemate-recorder). It is started with
 * startForegroundService, which works on phones (e.g. Vivo/iQOO) that block the bindService-based
 * service inside expo-audio. Null on iOS and on app builds made before this module existed.
 */
const native = Platform.OS === "android" ? requireOptionalNativeModule<SitemateRecorderModule>("SitemateRecorder") : null;

export const hasOwnRecordingService = native != null;

export async function startRecordingService(text: string) {
  if (!native) throw new Error("SiteMate recording service is not in this app build");
  await native.startForegroundService(text);
}

export async function stopRecordingService() {
  await native?.stopForegroundService().catch(() => undefined);
}
