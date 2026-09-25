import { ComingSoon } from "@/components/ComingSoon";

export default function RecordScreen() {
  return (
    <ComingSoon
      title="Record"
      phase={2}
      lines={[
        "Big record button that keeps going with the screen locked",
        "Language picker: English, Tamil, Kannada, Telugu, Malayalam, Hindi",
        "Automatic notes: summary, decisions, action items, ₹ figures",
        "Quick voice / text memo",
      ]}
    />
  );
}
