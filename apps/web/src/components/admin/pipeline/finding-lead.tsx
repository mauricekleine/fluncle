import { FindingIdentity } from "@/components/admin/finding-identity";
import { type BoardRow } from "@/components/admin/use-publish";

// The board's finding lead — the shared FindingIdentity block bound to a BoardRow. The cover
// doubles as render status: a clip wears the gold story-ring + play badge (the One Sun gold
// spent on the live artifact); no badge means no video. Clicking a clip previews it.

export function FindingLead({
  logId,
  onPreview,
  row,
  size = "md",
}: {
  /** Show the Log ID coordinate above the title. */
  logId?: boolean;
  onPreview?: (row: BoardRow) => void;
  row: BoardRow;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <FindingIdentity
      artists={row.artists}
      cover={row.albumImageUrl}
      hasClip={Boolean(row.videoUrl)}
      logId={logId ? row.logId : undefined}
      onPreview={onPreview ? () => onPreview(row) : undefined}
      size={size}
      title={row.title}
    />
  );
}
