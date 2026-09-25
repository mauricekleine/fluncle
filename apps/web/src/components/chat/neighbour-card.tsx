import { Link } from "@tanstack/react-router";
import { ArtistAvatar } from "@/components/artist-avatar";

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
      <ul className="artist-similar-list" data-discovery="similar">
        {neighbours.map((neighbour) => (
          <li key={neighbour.slug}>
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
