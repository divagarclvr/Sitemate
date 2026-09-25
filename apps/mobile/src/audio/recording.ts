import { IOSOutputFormat, AudioQuality, type RecordingOptions } from "expo-audio";

/**
 * Speech-optimised recording: mono, 16 kHz, 32 kbps AAC ≈ 14 MB per hour.
 * Whisper works at 16 kHz anyway, and small files upload faster on site networks.
 */
export const SPEECH_RECORDING: RecordingOptions = {
  extension: ".m4a",
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  isMeteringEnabled: true,
  android: { outputFormat: "mpeg4", audioEncoder: "aac" },
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.HIGH },
  web: { mimeType: "audio/webm", bitsPerSecond: 32000 },
};

export function formatDuration(ms: number) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
