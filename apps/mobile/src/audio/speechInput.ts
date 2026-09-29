import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import { File } from "expo-file-system";
import { useRef, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { SPEECH_RECORDING } from "./recording";

/**
 * Speak instead of type: records a short clip (stops after `maxMs`), sends it for transcription
 * (English, Tamil, Kannada, Telugu, Malayalam, Hindi or a mix) and hands the text back.
 */
export function useSpeechInput(onText: (text: string) => void, onError: (message: string, hint?: string) => void, maxMs = 25_000) {
  const recorder = useAudioRecorder(SPEECH_RECORDING);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = async () => {
    if (timer.current) clearTimeout(timer.current);
    setListening(false);
    setTranscribing(true);
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
      if (!recorder.uri) throw new Error("No audio recorded");
      const f = new File(recorder.uri);
      const audio_base64 = await f.base64();
      f.delete();
      const r = await api<{ text: string }>("/v1/voice/transcribe", { method: "POST", body: JSON.stringify({ audio_base64, mime: "audio/mp4" }) });
      if (r.text.trim()) onText(r.text.trim());
      else onError("Couldn't hear anything.", "Hold the phone closer and try again.");
    } catch (e) {
      if (e instanceof ApiRequestError) onError(e.message, e.hint);
      else onError(String(e instanceof Error ? e.message : e));
    } finally {
      setTranscribing(false);
    }
  };

  const start = async () => {
    const p = await requestRecordingPermissionsAsync();
    if (!p.granted) return onError("Microphone permission is off.", "Allow it in phone Settings → Apps → SiteMate.");
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: false });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setListening(true);
      timer.current = setTimeout(() => void stop(), maxMs);
    } catch (e) {
      onError("Couldn't start the microphone.", String(e instanceof Error ? e.message : e));
    }
  };

  return { listening, transcribing, toggle: () => (listening ? void stop() : void start()) };
}
