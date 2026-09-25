import { TrackArtwork } from "@/components/track-artwork";
import { albumCoverAtSize } from "@/lib/media";

export function TrackSummary({
  artists,
  artworkUrl,
  title,
}: {
  artists: string[];
  artworkUrl?: string;
  title: string;
}) {
  return (
    <>
      <TrackArtwork src={albumCoverAtSize(artworkUrl, "small")} />
      <span className="min-w-0">
        <span className="block text-sm font-extrabold [overflow-wrap:anywhere]">{title}</span>
        <span className="mt-1 block text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {artists.join(", ")}
        </span>
      </span>
    </>
  );
}
