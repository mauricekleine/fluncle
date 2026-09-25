import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { type TrackListItem } from "@fluncle/contracts";
import { PlayCover } from "@/components/player/playable-list";
import { TrackArtwork } from "@/components/track-artwork";
import { discoveryQueueTrack, findingToDiscoveryTrack } from "@/lib/discovery-tracks";
import { artistTitleLine } from "@/lib/log-prose";
import { COVER_TILE_SIZE, albumCoverAtSize } from "@/lib/media";

export function FrontDoorFindings({ findings }: { findings: TrackListItem[] }): ReactNode {
  const tiles = findings.filter((finding) => finding.logId);

  if (tiles.length === 0) {
    return (
      <p className="fd-empty empty-scanlines">No findings logged yet. Quiet sector tonight.</p>
    );
  }

  return (
    <ul className="fd-finding-grid">
      {tiles.map((finding) =>
        finding.logId ? (
          <li className="fd-finding-tile" key={finding.trackId}>
            <FindingTileCover finding={finding} />
            <Link className="fd-finding" params={{ logId: finding.logId }} to="/log/$logId">
              <span className="fd-finding-coordinate">{finding.logId}</span>
              <span className="fd-finding-line">{artistTitleLine(finding)}</span>
            </Link>
          </li>
        ) : undefined,
      )}
    </ul>
  );
}

function FindingTileCover({ finding }: { finding: TrackListItem }): ReactNode {
  const cover = (
    <TrackArtwork
      alt=""
      className="fd-finding-cover"
      src={albumCoverAtSize(finding.albumImageUrl, COVER_TILE_SIZE)}
    />
  );
  const track = findingToDiscoveryTrack(finding);

  if (!track.previewable || !finding.logId) {
    return finding.logId ? (
      <Link aria-hidden="true" params={{ logId: finding.logId }} tabIndex={-1} to="/log/$logId">
        {cover}
      </Link>
    ) : (
      cover
    );
  }

  return (
    <PlayCover className="fd-finding-play" lit track={discoveryQueueTrack(track)}>
      {cover}
    </PlayCover>
  );
}
