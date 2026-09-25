import { ComingSoon } from "@/components/ComingSoon";

export default function ChatScreen() {
  return (
    <ComingSoon
      title="Ask SiteMate"
      phase={6}
      lines={[
        "“What did the plumbing vendor promise last week?”",
        "“List all pending items for Essence”",
        "Answers link back to the original note or file",
      ]}
    />
  );
}
