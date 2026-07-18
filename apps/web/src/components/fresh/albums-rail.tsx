// `/fresh` — the album records, cover-led. An album is a NAMED graph node (it has a page), so each
// tile links to `/album/<slug>` and carries its cover; the register is cream, never the unlit dust
// (this is not the uncertified tier). Newest first, like everything on the page.
//
// Two treatments off the same tile: the RAIL is the quiet strip under the track stream in the "All"
// view (today's 30-day cut); the BOARD is the wider grid the "Albums & EPs" view leads with, records
// brought to the centre with their "N tracks" count and a heading over an empty stretch.

import { FreshCoverCard } from "./shared";
import { type FreshCover } from "./data";

export function FreshAlbumsRail({ albums }: { albums: FreshCover[] }) {
  if (albums.length === 0) {
    return undefined;
  }

  return (
    <section aria-label="Albums just out" className="fresh-albums">
      <h2 className="fresh-section-label">Albums just out</h2>
      <ul className="fresh-albums-rail">
        {albums.map((album) => (
          <li key={album.key}>
            <FreshCoverCard className="fresh-album-tile" cover={album} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function FreshAlbumsBoard({ albums }: { albums: FreshCover[] }) {
  if (albums.length === 0) {
    return (
      <p className="fresh-empty empty-scanlines">No records have dropped lately. Quiet sector.</p>
    );
  }

  return (
    <section aria-label="Albums & EPs" className="fresh-albums-board">
      <ul className="fresh-albums-grid">
        {albums.map((album) => (
          <li key={album.key}>
            <FreshCoverCard className="fresh-album-tile" cover={album} showTrackCount />
          </li>
        ))}
      </ul>
    </section>
  );
}
