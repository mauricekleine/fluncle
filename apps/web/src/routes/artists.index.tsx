import { Link, createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { ArtistAvatar } from "@/components/artist-avatar";
import { CataloguePager } from "@/components/catalogue-groups";
import { HubLetterLane } from "@/components/catalogue-hub-section";
import { HubSearchInput } from "@/components/hub-search-input";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { siteUrl } from "@/lib/fluncle-links";
import { tracksCount } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { albumCoverAtSize, COVER_TILE_SIZE } from "@/lib/media";
import {
  type ArtistHubEntry,
  listArtistsHubPage,
  listSimilarArtistTiles,
} from "@/lib/server/artists";
import { type CatalogueHubNumberedPage } from "@/lib/server/labels";

// The artists index: ONE alphabetical index of every artist Fluncle holds — the certified findings
// and the wider catalogue he is charting — cover-led, each tile linking to its `/artist/<slug>`
// page. A certified artist's name takes the certification light (DESIGN.md's Unlit Rule, Eclipse
// Gold); an uncertified one keeps the plain ink. The distinction is visual only — no badge, no tier
// heading, no finding count.
//
// TWO browse modes ride the same index, both URL-driven (noindex, SSR):
//   - a NAME SEARCH (`?q=`) narrows the index SQL-side (the shared hub gate stays single-sourced) and
//     hides the A–Z lane (searching by name is not browsing the alphabet);
//   - a SOUND COMPARE (`?like=a,b`) is the "sounds like these" multi-select: pick two or more artists
//     and see who sits nearest to their average in Fluncle's audio-embedding space.
// The bare hub is indexable + in the sitemap; any `?q=` OR `?like=` present flips it to noindex (the
// /tracks filter rule). Every page — page 1 included — SSRs one static slice behind a real-anchor
// `?page=N` pager with an A–Z fast lane, so the whole index is reachable by internal links.

const countFormatter = new Intl.NumberFormat("en-US");

/** The most artists a "sounds like these" compare carries — matches the op's cap (artist-dossier). */
const MAX_COMPARE_SLUGS = 6;

type ArtistsFoundData = {
  hub: CatalogueHubNumberedPage<ArtistHubEntry>;
  page: number;
  /** The active name search, or undefined on the bare hub — the filtered/noindex bit keys off it. */
  q: string | undefined;
  status: "found";
};

type ArtistsSimilarData = {
  /** The nearest-in-sound results, as hub tiles (the unlit/lit treatment is reused verbatim). */
  results: ArtistHubEntry[];
  status: "similar";
};

type ArtistsPageData = ArtistsFoundData | ArtistsSimilarData | { status: "missing" };

async function resolveArtistsPage(
  page: number | undefined,
  q: string | undefined,
): Promise<ArtistsPageData> {
  const requested = page ?? 1;
  const hub = await listArtistsHubPage(requested, q);

  if (requested > hub.pageCount) {
    return { status: "missing" };
  }

  return { hub, page: requested, q, status: "found" };
}

const fetchArtistsPage = createServerFn({ method: "GET" })
  .validator((data: { page?: number; q?: string }) => data)
  .handler(({ data }): Promise<ArtistsPageData> => resolveArtistsPage(data.page, data.q));

/** Parse the raw `?like=` list into deduped, capped slugs (the same shape the op validates). */
function parseCompareSlugs(like: string): string[] {
  return [
    ...new Set(
      like
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].slice(0, MAX_COMPARE_SLUGS);
}

const fetchSimilarArtists = createServerFn({ method: "GET" })
  .validator((data: { like: string }) => data)
  .handler(async ({ data }): Promise<{ results: ArtistHubEntry[] }> => {
    const slugs = parseCompareSlugs(data.like);

    return { results: slugs.length > 0 ? await listSimilarArtistTiles(slugs) : [] };
  });

// Machine-facing strings stay honestly-plain third-person (the Narrator rule), and they carry the
// genre keyword: Bing flagged the hub layer for short titles + identical paged meta (2026-07-18).
const title = "Every drum & bass artist, A to Z · Fluncle";
const description =
  "Every drum & bass artist Fluncle holds, A to Z, with the labels that pressed their records.";

function pagedMeta(page: number): { description: string; title: string } {
  if (page <= 1) {
    return { description, title };
  }

  return {
    description: `Page ${page} of every drum & bass artist Fluncle holds, A to Z.`,
    title: `Every drum & bass artist, page ${page} · Fluncle`,
  };
}

/** The base meta tag set for a canonical + title/description pair (shared by both views). */
function metaTagsFor(canonical: string, meta: { description: string; title: string }) {
  return [
    { title: meta.title },
    { content: meta.description, name: "description" },
    { content: meta.title, property: "og:title" },
    { content: meta.description, property: "og:description" },
    { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
    { content: canonical, property: "og:url" },
    { content: "summary_large_image", name: "twitter:card" },
    { content: meta.title, name: "twitter:title" },
    { content: meta.description, name: "twitter:description" },
  ];
}

function artistsHead(loaderData: ArtistsPageData | undefined) {
  if (loaderData === undefined || loaderData.status === "missing") {
    return {};
  }

  // The sound-compare results are a filtered permutation of the one hub: noindexed onto the bare
  // `/artists` canonical, no CollectionPage (it would be structured-data noise on a noindexed view).
  if (loaderData.status === "similar") {
    const canonical = `${siteUrl}/artists`;
    const metaTags = metaTagsFor(canonical, pagedMeta(1));
    metaTags.push({ content: "noindex, follow", name: "robots" });

    return { links: [{ href: canonical, rel: "canonical" }], meta: metaTags };
  }

  // A name search collapses onto the bare `/artists` canonical and goes `noindex, follow` (the
  // /tracks filter rule). A clean paged view is its own canonical and real content — noindex NEVER.
  const filtered = loaderData.q !== undefined;
  const canonical =
    filtered || loaderData.page <= 1
      ? `${siteUrl}/artists`
      : `${siteUrl}/artists?page=${loaderData.page}`;
  const metaTags = metaTagsFor(canonical, pagedMeta(filtered ? 1 : loaderData.page));

  if (filtered) {
    metaTags.push({ content: "noindex, follow", name: "robots" });

    return { links: [{ href: canonical, rel: "canonical" }], meta: metaTags };
  }

  // The ItemList carries the page's tiles — every one is a real `/artist/<slug>` page — as the
  // `mainEntity` of a `CollectionPage`, with `numberOfItems` set to the whole index size.
  const artists = loaderData.hub.items;
  const collectionPage = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    mainEntity: {
      "@type": "ItemList",
      itemListElement: artists.map((artist, index) => ({
        "@type": "ListItem",
        name: artist.name,
        position: index + 1,
        url: `${siteUrl}/artist/${encodeURIComponent(artist.slug)}`,
      })),
      numberOfItems: loaderData.hub.total,
    },
    name: "Every drum & bass artist Fluncle holds",
    url: `${siteUrl}/artists`,
  };

  return {
    links: [{ href: canonical, rel: "canonical" }],
    meta: metaTags,
    // JSON-LD goes through `jsonLdScript`, which HTML-escapes the serialized payload before it
    // reaches the inline <script> (rendered raw via dangerouslySetInnerHTML), so a `</script>` in a
    // (Spotify-sourced) artist name can't break out of the <script> (stored-XSS sink).
    scripts: [jsonLdScript(collectionPage)],
  };
}

// Route options follow TanStack's create-route-property-order (validateSearch → loaderDeps → loader →
// head → component); each step feeds the next's inferred types, so the order isn't alphabetical.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/artists/")({
  validateSearch: (search: Record<string, unknown>): ArtistsSearch => ({
    like: qParam(search["like"]),
    page: pageParam(search["page"]),
    q: qParam(search["q"]),
  }),
  loaderDeps: ({ search }) => ({ like: search.like, page: search.page, q: search.q }),
  loader: async ({ deps }): Promise<ArtistsPageData> => {
    if (deps.like !== undefined) {
      const data = await fetchSimilarArtists({ data: { like: deps.like } });

      return { results: data.results, status: "similar" };
    }

    const data = await fetchArtistsPage({ data: { page: deps.page, q: deps.q } });

    if (data.status === "missing") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: ArtistsPageData }) => artistsHead(loaderData),
  component: ArtistsPage,
  notFoundComponent: StoryNotFoundState,
});

type ArtistsSearch = { like?: string; page?: number; q?: string };

/** A page param the reader typed: junk or an absent value folds to undefined (the param-free view). */
function pageParam(value: unknown): number | undefined {
  const n = Number(value);

  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined;
}

/** A trimmed non-empty string param (`?q=` / `?like=`); empty / non-string folds to undefined. */
function qParam(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

// One composed string (not JSX fragments) so the count is a single SSR text node. The count clause
// drops at ≤ 1 ("1 drum & bass artists" is not a sentence).
function mastheadLine(total: number): string {
  return total > 1
    ? `${countFormatter.format(total)} drum & bass artists, A to Z.`
    : "Drum & bass artists, A to Z.";
}

/** "1 match" / "312 matches" — the count a name search holds, by the form when it is active. */
function matchCount(count: number): string {
  return `${countFormatter.format(count)} ${count === 1 ? "match" : "matches"}`;
}

/** The tile's inner content — the avatar over the name + track count, shared by the link, the select
 *  button, and the results tile so all three read identically. */
function ArtistTileContent({ artist }: { artist: ArtistHubEntry }) {
  return (
    <>
      <ArtistAvatar
        className="artist-card-avatar"
        name={artist.name}
        src={albumCoverAtSize(artist.imageUrl, COVER_TILE_SIZE)}
      />
      <span className="artist-grid-line">{artist.name}</span>
      <span className="artist-grid-count">{tracksCount(artist.trackCount)}</span>
    </>
  );
}

/**
 * The browse grid + its quiet "Compare sounds" select mode. At rest every tile is a link to its
 * `/artist/<slug>` page. In select mode each tile becomes a toggle button (aria-pressed, keyboard
 * operable) with a focus-ring selection outline (NOT gold — the light stays with the findings, One
 * Sun); picking two or more and hitting "Sounds like these" navigates to `?like=a,b`.
 */
function ArtistsBrowseGrid({ artists }: { artists: ArtistHubEntry[] }) {
  const navigate = useNavigate();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const toggle = (slug: string) =>
    setSelected((prev) =>
      prev.includes(slug)
        ? prev.filter((value) => value !== slug)
        : [...prev, slug].slice(0, MAX_COMPARE_SLUGS),
    );

  const exit = () => {
    setSelecting(false);
    setSelected([]);
  };

  const compare = () => {
    if (selected.length >= 2) {
      void navigate({ search: { like: selected.join(",") }, to: "/artists" });
    }
  };

  return (
    <>
      <div className="hub-compare-bar">
        {selecting ? (
          <>
            <span aria-live="polite" className="hub-compare-hint">
              {selected.length < 2
                ? "Pick two or more artists to compare."
                : `${selected.length} selected.`}
            </span>
            <Button onClick={exit} size="sm" type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={selected.length < 2} onClick={compare} size="sm" type="button">
              Sounds like these
            </Button>
          </>
        ) : (
          <Button onClick={() => setSelecting(true)} size="sm" type="button" variant="ghost">
            Compare sounds
          </Button>
        )}
      </div>

      <ul aria-label="Artists" className="artist-avatar-grid hub-grid">
        {artists.map((artist) => (
          <li key={artist.slug}>
            {selecting ? (
              <button
                aria-pressed={selected.includes(artist.slug)}
                className={`hub-tile-select${artist.certified ? " hub-tile-certified" : ""}`}
                onClick={() => toggle(artist.slug)}
                type="button"
              >
                <ArtistTileContent artist={artist} />
              </button>
            ) : (
              <Link
                className={artist.certified ? "hub-tile-certified" : undefined}
                params={{ slug: artist.slug }}
                to="/artist/$slug"
              >
                <ArtistTileContent artist={artist} />
              </Link>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** The `?like=a,b` results view — the artists nearest in sound to the compared set. */
function ArtistsSimilarView({ results }: { results: ArtistHubEntry[] }) {
  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Artists</h1>
          <p className="log-index-intro">Drum &amp; bass artists, closest in sound first.</p>
        </header>

        {results.length === 0 ? (
          <p className="log-index-empty empty-scanlines">No close matches yet.</p>
        ) : (
          <ul aria-label="Artists that sound alike" className="artist-avatar-grid hub-grid">
            {results.map((artist) => (
              <li key={artist.slug}>
                <Link
                  className={artist.certified ? "hub-tile-certified" : undefined}
                  params={{ slug: artist.slug }}
                  to="/artist/$slug"
                >
                  <ArtistTileContent artist={artist} />
                </Link>
              </li>
            ))}
          </ul>
        )}

        <footer className="log-plate-footer">
          <Link to="/artists">Back to artists</Link>
          <Link to="/log">The full log</Link>
        </footer>
      </article>
    </main>
  );
}

function ArtistsPage() {
  const data = Route.useLoaderData();
  const navigate = useNavigate();

  if (data.status === "missing") {
    return null;
  }

  if (data.status === "similar") {
    return <ArtistsSimilarView results={data.results} />;
  }

  const { hub, q } = data;
  const filtered = q !== undefined;
  const buildHref = (page: number) => buildArtistsHref(q, page);
  const showSearch = filtered || hub.total > 0;

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Artists</h1>
          {/* On a filtered view the count drops — the whole-index total would mis-caption a slice, so
              the matchline below owns that number (the /tracks rule). ONE composed string. */}
          <p className="log-index-intro">{mastheadLine(filtered ? 0 : hub.total)}</p>
        </header>

        {showSearch ? (
          <HubSearchInput
            label="Search artists by name"
            onSearch={(term) => void navigate({ search: { q: term }, to: "/artists" })}
            placeholder="Search artists"
            value={q}
          />
        ) : undefined}

        {filtered ? (
          <p aria-live="polite" className="tracks-hub-matchline">
            {matchCount(hub.total)}
          </p>
        ) : undefined}

        {hub.items.length === 0 ? (
          <p className="log-index-empty empty-scanlines">
            {filtered ? "No artists match that name." : "No drum & bass artists yet."}
          </p>
        ) : (
          <>
            {/* The A–Z lane hides while searching (a name search has already narrowed the list). */}
            {filtered ? undefined : (
              <HubLetterLane
                buildHref={buildHref}
                label="Artists A to Z"
                letters={hub.letters ?? []}
              />
            )}
            <ArtistsBrowseGrid artists={hub.items} />
            <CataloguePager
              buildHref={buildHref}
              label="Artists, more pages"
              page={hub.page}
              pageCount={hub.pageCount}
            />
          </>
        )}

        <footer className="log-plate-footer">
          <Link to="/">Home</Link>
          <Link to="/log">The full log</Link>
        </footer>
      </article>
    </main>
  );
}

/** Build an `/artists?…` href preserving the active name search across pages (page 1 drops `page`). */
function buildArtistsHref(q: string | undefined, page: number): string {
  const params = new URLSearchParams();

  if (q !== undefined) {
    params.set("q", q);
  }
  if (page > 1) {
    params.set("page", String(page));
  }

  const query = params.toString();

  return query ? `/artists?${query}` : "/artists";
}
