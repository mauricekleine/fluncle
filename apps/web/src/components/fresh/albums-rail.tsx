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
