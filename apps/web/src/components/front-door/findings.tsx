// SELECTIVE FINDINGS — the band under the lead.
//
// A short, cover-led row of the newest findings, each one a link to its coordinate page. It is a
// WINDOW onto `/findings`, never a feed: nothing loads on scroll, there is no pager, and the section
// hands over to the full archive with one link. That restraint is the whole point of the front door
// (PRODUCT.md "The front door") — a stranger should be able to see the shape of the thing and leave
// in any direction, not be handed an infinite list.
//
// ── THE REGISTER ─────────────────────────────────────────────────────────────────────────────
// Every row here is certified, so every row is lit: the cover, the Log ID coordinate in Oxanium, the
// gold heat on hover. Only coordinate-bearing findings render, because the tile IS a log link. The
// uncertified archive is a DIFFERENT band further down the page, in a different register — the
// distinction is carried by placement and light, and named nowhere (DESIGN.md's Unlit Rule).
//
// Every cover here is lazy. The lead's cover above is the page's one eager image; the signal only
// helps while it is scarce.

import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { type TrackListItem } from "@fluncle/contracts";
import { TrackArtwork } from "@/components/track-artwork";
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
          <li key={finding.trackId}>
            <Link className="fd-finding" params={{ logId: finding.logId }} to="/log/$logId">
              <TrackArtwork
                alt=""
                className="fd-finding-cover"
                src={albumCoverAtSize(finding.albumImageUrl, COVER_TILE_SIZE)}
              />
              <span className="fd-finding-coordinate">{finding.logId}</span>
              <span className="fd-finding-line">{artistTitleLine(finding)}</span>
            </Link>
          </li>
        ) : undefined,
      )}
    </ul>
  );
}
