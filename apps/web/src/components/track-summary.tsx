import { TrackArtwork } from "@/components/track-artwork";
import { spotifyAlbumImageAtSize } from "@/lib/media";

// The compact artwork + title + artist block shared by the dialog tiles
// (random banger, submit-track search results). The interactive wrapper —
// plain tile or selectable button — stays with the caller.
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
      {/* The tile slot is ~52px: request the small Spotify rendition. */}
      <TrackArtwork src={spotifyAlbumImageAtSize(artworkUrl, "small")} />
      <span className="min-w-0">
        <span className="block text-sm font-extrabold [overflow-wrap:anywhere]">{title}</span>
        <span className="mt-1 block text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {artists.join(", ")}
        </span>
      </span>
    </>
  );
}
