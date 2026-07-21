import { type ChatFinding, FindingCard } from "@/components/chat/finding-card";
import { type KeyNotation } from "@/lib/key-notation";

// A stack of Finding Cards for a multi-result tool output (list_findings / search_archive). The
// tools already clamp (search at 12, list at 48), but a chat turn should not spill a wall of
// cards — the list renders at most 8 and names the rest as a quiet "+N more in the archive" line,
// so a broad dig still reads as a conversation.
const MAX_CARDS = 8;

export function FindingList({
  findings,
  notation,
}: {
  findings: ChatFinding[];
  notation: KeyNotation;
}) {
  const shown = findings.slice(0, MAX_CARDS);
  const remaining = findings.length - shown.length;

  return (
    <div className="flex flex-col gap-2">
      {shown.map((finding, index) => (
        <FindingCard finding={finding} key={finding.coordinate ?? index} notation={notation} />
      ))}
      {remaining > 0 ? (
        <p className="px-1 text-xs text-muted-foreground">+{remaining} more in the archive</p>
      ) : null}
    </div>
  );
}
