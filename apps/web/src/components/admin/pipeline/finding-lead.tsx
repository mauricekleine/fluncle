import { FindingIdentity } from "@/components/admin/finding-identity";
import { type BoardRow } from "@/components/admin/use-publish";

export function FindingLead({
  logId,
  onPreview,
  row,
  size = "md",
}: {
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
