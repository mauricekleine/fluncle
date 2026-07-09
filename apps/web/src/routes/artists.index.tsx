import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { TrackArtwork } from "@/components/track-artwork";
import { siteUrl } from "@/lib/fluncle-links";
import { jsonLdScript } from "@/lib/json-ld";
import { spotifyAlbumImageAtSize } from "@/lib/media";
import { type ArtistIndexEntry, listArtistsWithFindingCounts } from "@/lib/server/artists";

// The artists index: every artist Fluncle has logged a finding from, cover-led,
// each linking to its `/artist/<slug>` page — the internal-link hub that keeps the
// artist pages from being orphans (Unit 3, artist-relationship RFC §3).

const fetchArtists = createServerFn({ method: "GET" }).handler(() =>
  listArtistsWithFindingCounts(),
);

const title = "Fluncle: the artists";
const description =
  "Every artist Fluncle has found and logged in the Galaxy, mapped by the bangers they made.";

function artistsHead(loaderData: ArtistIndexEntry[] | undefined) {
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: loaderData?.map((artist, index) => ({
      "@type": "ListItem",
      name: artist.name,
      position: index + 1,
      url: `${siteUrl}/artist/${encodeURIComponent(artist.slug)}`,
    })),
    name: "Fluncle's artists",
    url: `${siteUrl}/artists`,
  };

  return {
    links: [{ href: `${siteUrl}/artists`, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: `${siteUrl}/artists`, property: "og:url" },
    ],
    // JSON-LD goes through `jsonLdScript`, which HTML-escapes the serialized
    // payload before it reaches the inline <script>'s `children` (rendered raw via
    // dangerouslySetInnerHTML), so a `</script>` in a (Spotify-sourced) artist name
    // can't break out of the <script> (stored-XSS sink, security review).
    scripts: [jsonLdScript(itemList)],
  };
}

// oxlint-disable-next-line sort-keys -- TanStack canonical property order (loader before head); see AGENTS.md
export const Route = createFileRoute("/artists/")({
  component: ArtistsPage,
  loader: () => fetchArtists(),
  head: ({ loaderData }: { loaderData?: ArtistIndexEntry[] }) => artistsHead(loaderData),
});

function ArtistsPage() {
  const artists = Route.useLoaderData();

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title">Artists</h1>
          <p className="log-index-intro">
            Everyone I've found a banger from out here. {artists.length} logged so far.
          </p>
        </header>

        {artists.length === 0 ? (
          <p className="log-index-empty empty-scanlines">No artists logged yet. Quiet sector.</p>
        ) : (
          <ul className="artist-grid" aria-label="Artists">
            {artists.map((artist) => (
              <li key={artist.slug}>
                <Link params={{ slug: artist.slug }} to="/artist/$slug">
                  <TrackArtwork
                    alt=""
                    className="artist-grid-cover"
                    src={spotifyAlbumImageAtSize(artist.coverImageUrl, "large")}
                  />
                  <span className="artist-grid-line">{artist.name}</span>
                  <span className="artist-grid-count">
                    {artist.findingCount} {artist.findingCount === 1 ? "finding" : "findings"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <footer className="log-plate-footer">
          <Link to="/">Back to the archive</Link>
          <Link to="/log">The full log</Link>
        </footer>
      </article>
    </main>
  );
}
