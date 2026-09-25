import { ComingSoon } from "@/components/ComingSoon";

export default function NotesScreen() {
  return (
    <ComingSoon
      title="Notes"
      phase={2}
      lines={["All meetings, memos, calls and files", "Search and edit transcripts", "Filter by project or contact"]}
    />
  );
}
