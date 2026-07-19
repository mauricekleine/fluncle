import { Link } from "@tanstack/react-router";
import { ArtistAvatar } from "@/components/artist-avatar";

// THE NEIGHBOUR LIST — the artists whose sound sits nearest one Fluncle named, rendered (ChatDnB).
//
// When the chat's get_similar_artists tool resolves, the workbench shows the same "similar artists"
// chip rail the /artist page wears instead of a raw JSON marker: a round avatar + the artist name,
// each chip a graph link to that artist's page. The rail reaches the WHOLE embedded archive, so a
// neighbour Fluncle never certified rides the UNLIT register (DESIGN.md's Unlit Rule): its avatar
// sits a step down and the chip stays cool — listed, never introduced, no gold. Naming an artist is
// always allowed; the Unlit Rule silences uncertified TRACKS, never the artists themselves. This
// reuses the /artist rail's `.artist-similar-*` classes verbatim, so chat reads like the page.

/**
 * A neighbouring artist as get_similar_artists emits it — the identity a chip needs, plus
 * `certified`: whether Fluncle has ≥1 finding from them. A catalogue-only neighbour
 * (`certified: false`) renders unlit. Mirrors the server's `ArtistNeighbour`.
 */
export type ChatNeighbour = {
  certified: boolean;
  imageUrl?: string;
  name: string;
  slug: string;
};

export function NeighbourList({
  neighbours,
  of,
}: {
  neighbours: ChatNeighbour[];
  /** The artist the neighbours sit near — names the anchor in the quiet header. */
  of?: { name?: string; slug?: string };
}) {
  if (neighbours.length === 0) {
    return null;
  }

  const anchorName = of?.name;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-card px-3 py-2.5">
      <p className="px-1 text-xs text-muted-foreground">
        {anchorName ? `Artists like ${anchorName}` : "Similar artists"}
      </p>
      <ul className="artist-similar-list">
        {neighbours.map((neighbour) => (
          <li key={neighbour.slug}>
            {/* A neighbour Fluncle never certified renders UNLIT (the Unlit Rule): the chip stays
                cool and the avatar sits a step down, mirroring the /artist rail exactly. Focus
                stays loud. */}
            <Link
              aria-label={`Open the artist page for ${neighbour.name}`}
              className={
                neighbour.certified
                  ? "artist-similar-link"
                  : "artist-similar-link artist-similar-link--unlit"
              }
              params={{ slug: neighbour.slug }}
              to="/artist/$slug"
            >
              <ArtistAvatar
                className={
                  neighbour.certified
                    ? "artist-similar-avatar"
                    : "artist-similar-avatar artist-similar-avatar--unlit"
                }
                name={neighbour.name}
                src={neighbour.imageUrl}
              />
              <span>{neighbour.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
