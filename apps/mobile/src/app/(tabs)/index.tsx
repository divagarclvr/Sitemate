import { ComingSoon } from "@/components/ComingSoon";

export default function TodayScreen() {
  return (
    <ComingSoon
      title="Today"
      phase={5}
      lines={[
        "Morning plan at 7:30 AM",
        "Today's meetings with one-tap recording",
        "Tasks due today and overdue",
        "Follow-up calls to make",
      ]}
    />
  );
}
