// `/fresh` — the "Albums just out" rail, shared across variants. An album is a NAMED graph node (it
// has a page), so each tile links to `/album/<slug>` and carries its cover; the register is cream,
// never the unlit dust (this is not the uncertified tier). Newest first, like everything on the page.

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
