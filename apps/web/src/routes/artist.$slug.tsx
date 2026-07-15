import { GlobeSimpleIcon } from "@phosphor-icons/react";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  siBandcamp,
  siBeatport,
  siFacebook,
  siInstagram,
  siMixcloud,
  siSoundcloud,
  siSpotify,
  siTiktok,
  siTwitch,
  siX,
  siYoutube,
} from "simple-icons";
import { ArtistAvatar } from "@/components/artist-avatar";
import { BrandIcon } from "@/components/brand-icon";
import {
  CataloguePager,
  CatalogueRecords,
  CatalogueSortControl,
} from "@/components/catalogue-groups";
import { GraphLink } from "@/components/graph-link";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { TrackArtwork } from "@/components/track-artwork";
import { type ArtistSocialPlatform } from "@/lib/artist-socials";
import { siteUrl } from "@/lib/fluncle-links";
import { artistSignatureLine } from "@/lib/graph-prose";
import { jsonLdScript } from "@/lib/json-ld";
import { artistBreadcrumbsJsonLd, musicGroupJsonLd } from "@/lib/log-schema";
import { bioMetaDescription } from "@/lib/meta-description";
import { artistTitleLine } from "@/lib/log-prose";
import { albumCoverAtSize } from "@/lib/media";
import {
  type ArtistNeighbour,
  type ArtistSignature,
  getArtistNeighbours,
  summarizeArtistSignature,
} from "@/lib/server/artist-dossier";
import {
  ARTIST_INDEX_MIN_FINDINGS,
  type ArtistSocialLink,
  countArtistFindings,
  getArtistBySlug,
  getPublicArtistSocials,
} from "@/lib/server/artists";
import {
  CataloguePageOutOfRangeError,
  type CatalogueGroupPage,
  type CatalogueRecord,
  type CatalogueSort,
  listArtistCatalogue,
  parseCatalogueSort,
} from "@/lib/server/catalogue-groups";
import { getFindingsByArtist, type TrackListItem } from "@/lib/server/tracks";

// The dossier bundled onto the page data: the pure signature (first-found, tempo,
// keys) plus the "same sector" neighbours. Assembled in the loader so the whole
// page arrives in one SSR payload (no client round-trip), matching the route's
// existing loader-only shape.
type ArtistDossier = ArtistSignature & {
  findingCount: number;
  neighbours: ArtistNeighbour[];
};

// The artist page: a dark, cover-led Instagram-style grid of Fluncle's findings
// for one artist, under a plate masthead (name + a Fluncle-voice frame + the
// confirmed socials row). Held to DESIGN.md — a Fluncle cover grid, not a bright
// streaming clone. The @id graph + MusicGroup/sameAs JSON-LD make it the entity's
// home for crawlers + AI answer-engines (Unit 3, artist-relationship RFC §3).

type ArtistPageData =
  | {
      // The artist's voiced bio — a short paragraph beneath the dateline, undefined until one
      // is authored (lib/server/bio.ts). The masthead renders it only when present.
      bio: string | undefined;
      // The rest of this artist's catalogue — their crawled tracks grouped into records, one
      // page of it (`catalogue-groups.ts` owns the bound). Empty until the catalogue lands.
      catalogue: CatalogueGroupPage<CatalogueRecord>;
      dossier: ArtistDossier;
      findings: TrackListItem[];
      indexable: boolean;
      name: string;
      slug: string;
      socials: ArtistSocialLink[];
      sort: CatalogueSort;
      status: "found";
      // The identity graph the JSON-LD's sameAs draws on (KG anchors).
      mbid: string | undefined;
      spotifyUrl: string | undefined;
      wikidataQid: string | undefined;
    }
  | { status: "missing" };

// A confirmed/auto social — the brand mark + a plain label, from simple-icons
// (never a Phosphor glyph for a brand). `homepage` is not a brand, so it takes the
// Phosphor globe (an interface icon) — DESIGN.md "Iconography".
const SOCIAL_META: Record<
  Exclude<ArtistSocialPlatform, "homepage">,
  { path: string; title: string }
> = {
  bandcamp: siBandcamp,
  beatport: siBeatport,
  facebook: siFacebook,
  instagram: siInstagram,
  mixcloud: siMixcloud,
  soundcloud: siSoundcloud,
  spotify: siSpotify,
  tiktok: siTiktok,
  twitch: siTwitch,
  twitter: siX,
  youtube: siYoutube,
};

const SOCIAL_LABEL: Record<ArtistSocialPlatform, string> = {
  bandcamp: "Bandcamp",
  beatport: "Beatport",
  facebook: "Facebook",
  homepage: "Website",
  instagram: "Instagram",
  mixcloud: "Mixcloud",
  soundcloud: "SoundCloud",
  spotify: "Spotify",
  tiktok: "TikTok",
  twitch: "Twitch",
  twitter: "X",
  youtube: "YouTube",
};

// Resolve the artist page's data. Extracted from the server fn so the indexability decision is
// unit-testable (see -artist-page.test.ts). An artist earns a page on its CONTENT, exactly as a
// label/album does: a `getArtistBySlug` row renders, and the thin-content gate below (not a
// certified-finding gate) decides whether it indexes. The grid's `findings` come from
// `getFindingsByArtist` (which has an `artists_json` fallback so a pre-backfill artist still shows
// its covers), but the `indexable` gate keys off `countArtistFindings` + the catalogue's
// `totalTracks` — the SAME canonical `track_artists` join the sitemap uses — so an indexable page
// is never orphaned from the sitemap.
export async function resolveArtistPageData(
  slug: string,
  sort: CatalogueSort,
  page: number,
): Promise<ArtistPageData> {
  const artist = await getArtistBySlug(slug);

  if (!artist) {
    return { status: "missing" };
  }

  let catalogue: CatalogueGroupPage<CatalogueRecord>;

  try {
    catalogue = await listArtistCatalogue(artist.id, sort, page);
  } catch (error) {
    // A page past the end of the pager is genuinely not-found, not a 500 — a crawler or a
    // hand-typed `?page=99` on a 3-page artist gets an honest 404, never an empty page that
    // duplicates page 1's content under a new URL.
    if (error instanceof CataloguePageOutOfRangeError) {
      return { status: "missing" };
    }

    throw error;
  }

  const [findings, socials, canonicalFindingCount, neighbours] = await Promise.all([
    getFindingsByArtist(artist.id, artist.name),
    getPublicArtistSocials(artist.id),
    countArtistFindings(artist.id),
    getArtistNeighbours(artist.id),
  ]);

  // The signature is pure over the findings already loaded for the grid (no extra
  // query); the neighbours came from the corpus-wide embedding pass above.
  const gridFindings = findings.filter((finding) => finding.logId);
  const signature = summarizeArtistSignature(
    gridFindings.map((finding) => ({ addedAt: finding.addedAt })),
  );

  return {
    bio: artist.bio,
    catalogue,
    dossier: { ...signature, findingCount: gridFindings.length, neighbours },
    findings,
    // Thin-content gate: index only past ARTIST_INDEX_MIN_FINDINGS RENDERABLE tracks — the
    // certified findings PLUS the quieter catalogue rows, because both are real content on the
    // page and a page is thin or not thin on what it RENDERS, never on who wrote it. Both counts
    // read through the canonical `track_artists` join (`countArtistFindings` + the catalogue's
    // SQL-counted `totalTracks`), the same source the sitemap keys off, so an indexable page is
    // never orphaned from it. Below the floor the page still serves 200 (deep links, link equity)
    // but is noindex + out of the sitemap. A crawl-minted, findings-free artist with enough
    // catalogue tracks is a real page and indexes; a 1–2-track one renders noindex
    // (docs/artist-relationship.md).
    indexable: canonicalFindingCount + catalogue.totalTracks >= ARTIST_INDEX_MIN_FINDINGS,
    mbid: artist.mbid,
    name: artist.name,
    slug: artist.slug,
    socials,
    sort,
    spotifyUrl: artist.spotifyUrl,
    status: "found",
    wikidataQid: artist.wikidataQid,
  };
}

const fetchArtist = createServerFn({ method: "GET" })
  .validator((data: { page: number; slug: string; sort: CatalogueSort }) => data)
  .handler(
    ({ data: { page, slug, sort } }): Promise<ArtistPageData> =>
      resolveArtistPageData(slug, sort, page),
  );

function artistHead(loaderData: ArtistPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  const {
    bio,
    catalogue,
    findings,
    indexable,
    name,
    slug,
    socials,
    mbid,
    spotifyUrl,
    wikidataQid,
  } = loaderData;
  // Self-referencing PER PAGE, sort-collapsing (the label page carries the long note): page 2
  // is its own canonical, but the sort param always drops so order-variants of one page fold to
  // one URL. Page 1 stays the bare `/artist/<slug>`.
  const pageUrl =
    catalogue.page > 1
      ? `${siteUrl}/artist/${slug}?page=${catalogue.page}`
      : `${siteUrl}/artist/${slug}`;
  // The <title>/meta stay honestly-plain third-person (the Narrator rule); the
  // first person lives only in the on-page voice frame.
  const title = `${name} · Fluncle's Findings`;
  // The factual bio is the honest, UNIQUE description when one is authored — the same objective
  // paragraph the page prints, trimmed to the meta cap. Absent (the bio backfill is in flight for
  // many artists), it falls back to the templated line verbatim, so nothing regresses. This one
  // string flows to meta + og + twitter below, so all three go unique together.
  const description =
    bio !== undefined
      ? bioMetaDescription(bio)
      : findings.length > 0
        ? `Every ${name} banger Fluncle has found and logged in the Galaxy, ${findings.length} so far, each with a coordinate.`
        : `${name} in Fluncle's Galaxy.`;
  const coverFinding = findings[0];
  const imageUrl =
    (coverFinding ? albumCoverAtSize(coverFinding.albumImageUrl, "large") : undefined) ??
    `${siteUrl}/fluncle-cover.png`;

  const musicGroup = musicGroupJsonLd(
    {
      bio,
      imageUrl,
      mbid,
      name,
      slug,
      socials: socials.map((social) => social.url),
      spotifyUrl,
      wikidataQid,
    },
    findings.flatMap((finding) =>
      finding.logId
        ? [{ artists: finding.artists, logId: finding.logId, title: finding.title }]
        : [],
    ),
  );

  return {
    links: [
      { href: pageUrl, rel: "canonical" },
      // oEmbed discovery: a pasted /artist link unfurls as a `link`-type card
      // (name + cover). See routes/oembed.ts.
      {
        href: `${siteUrl}/oembed?url=${encodeURIComponent(pageUrl)}&format=json`,
        rel: "alternate",
        title,
        type: "application/json+oembed",
      },
    ],
    meta: [
      { title },
      { content: description, name: "description" },
      // Below the thin-content threshold: keep the page reachable + link equity
      // flowing, but out of the index (noindex, follow).
      ...(indexable ? [] : [{ content: "noindex, follow", name: "robots" }]),
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: imageUrl, property: "og:image" },
      { content: pageUrl, property: "og:url" },
      { content: "profile", property: "og:type" },
      { content: "summary_large_image", name: "twitter:card" },
      { content: title, name: "twitter:title" },
      { content: description, name: "twitter:description" },
      { content: imageUrl, name: "twitter:image" },
    ],
    // JSON-LD goes through `jsonLdScript`, which HTML-escapes the serialized
    // payload before it reaches the inline <script>'s `children` (rendered raw via
    // dangerouslySetInnerHTML), so a `</script>` in a (Spotify-sourced) artist or
    // track name can't break out of the <script> (stored-XSS sink, security review).
    scripts: [jsonLdScript(musicGroup), jsonLdScript(artistBreadcrumbsJsonLd(name))],
  };
}

// Route options follow TanStack's create-route-property-order (each step feeds the
// next's inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/artist/$slug")({
  validateSearch: (search: Record<string, unknown>): ArtistSearch => ({
    page: pageParam(search["page"]),
    sort: sortParam(search["sort"]),
  }),
  // Defaults land HERE, so the loader always gets a real page + sort while the URL keeps them
  // implicit (a bare `/artist/<slug>` is the canonical, crawlable view).
  loaderDeps: ({ search }) => ({ page: search.page ?? 1, sort: parseCatalogueSort(search.sort) }),
  loader: async ({ deps, params }): Promise<ArtistPageData> => {
    const data = await fetchArtist({
      data: { page: deps.page, slug: params.slug, sort: deps.sort },
    });

    if (data.status === "missing") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: ArtistPageData }) => artistHead(loaderData),
  component: ArtistPage,
  notFoundComponent: StoryNotFoundState,
});

// Both params OPTIONAL, so a plain `<Link to="/artist/$slug">` anywhere still type-checks with
// no `search` prop (the `HomeSearch.story?` precedent).
type ArtistSearch = { page?: number; sort?: CatalogueSort };

/** A page param the reader typed: junk or an absent value folds to undefined (default 1). */
function pageParam(value: unknown): number | undefined {
  const n = Number(value);

  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined;
}

/** A sort param the reader typed: only a known sort survives, so a junk value stays implicit. */
function sortParam(value: unknown): CatalogueSort | undefined {
  return value === "name" || value === "recent" ? value : undefined;
}

function SocialLink({ social }: { social: ArtistSocialLink }) {
  const label = SOCIAL_LABEL[social.platform];

  return (
    <a className="artist-social" href={social.url} rel="noreferrer" target="_blank" title={label}>
      {social.platform === "homepage" ? (
        <GlobeSimpleIcon aria-hidden="true" weight="bold" />
      ) : (
        <BrandIcon icon={SOCIAL_META[social.platform]} />
      )}
      <span>{label}</span>
    </a>
  );
}

function ArtistPage() {
  const data = Route.useLoaderData();
  const navigate = Route.useNavigate();

  if (data.status !== "found") {
    return null;
  }

  const { bio, catalogue, dossier, findings, name, slug, socials, sort } = data;
  const grid = findings.filter((finding) => finding.logId);

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title artist-name">{name}</h1>
          <p className="log-index-intro">
            {artistSignatureLine(name, dossier.findingCount, dossier.firstFoundAt)}
          </p>
          {/* The voiced bio sits directly beneath the dateline — body prose that augments the
              relationship line, never replaces it. Only rendered once one is authored. */}
          {bio ? <p className="log-index-bio">{bio}</p> : undefined}
        </header>

        {/* The findings lead: the logged tracks are the primary entity in the
            Galaxy — the artist page frames THEM. Socials and kin follow. */}
        {grid.length === 0 ? (
          <p className="log-index-empty empty-scanlines">Quiet sector.</p>
        ) : (
          <ul className="artist-grid" aria-label={`Findings featuring ${name}`}>
            {grid.map((finding) =>
              finding.logId ? (
                <li key={finding.trackId}>
                  <Link params={{ logId: finding.logId }} to="/log/$logId">
                    <TrackArtwork
                      alt=""
                      className="artist-grid-cover"
                      src={albumCoverAtSize(finding.albumImageUrl, "large")}
                    />
                    <span className="artist-grid-line">{artistTitleLine(finding)}</span>
                  </Link>
                </li>
              ) : null,
            )}
          </ul>
        )}

        {socials.length > 0 ? (
          <nav aria-label={`Follow ${name}`} className="artist-follow">
            <p className="artist-similar-label">Follow {name}</p>
            <div className="artist-socials">
              {socials.map((social) => (
                <SocialLink key={social.platform} social={social} />
              ))}
            </div>
          </nav>
        ) : undefined}

        {dossier.neighbours.length > 0 ? (
          <nav aria-label="Similar artists" className="artist-similar">
            <p className="artist-similar-label">Similar artists</p>
            <ul className="artist-similar-list">
              {dossier.neighbours.map((neighbour) => (
                <li key={neighbour.slug}>
                  {/* The same graph link as everywhere else, in its chip skin — hovering a kin
                      artist previews them before you commit to the click. */}
                  <GraphLink
                    className="artist-similar-link"
                    kind="artist"
                    slug={neighbour.slug}
                    variant="chip"
                  >
                    <ArtistAvatar
                      className="artist-similar-avatar"
                      name={neighbour.name}
                      src={neighbour.imageUrl}
                    />
                    <span>{neighbour.name}</span>
                  </GraphLink>
                </li>
              ))}
            </ul>
          </nav>
        ) : undefined}

        {/* The rest of this artist's catalogue: the crawled tracks Fluncle never certified,
            grouped into their records, each collapsing to its tracklist. Conditional like every
            band here — nothing renders until the crawl fills it. The sort control rides above
            only with more than one record to order; the pager only with more than one page. */}
        {catalogue.groups.length > 0 ? (
          <section aria-label={`More from ${name}`} className="catalogue-section">
            {catalogue.totalGroups > 1 ? (
              <CatalogueSortControl
                label="Sort records"
                onChange={(next) => navigate({ search: { sort: next } })}
                sort={sort}
              />
            ) : undefined}

            <CatalogueRecords artistName={name} records={catalogue.groups} />

            <CataloguePager
              buildHref={(page) => `/artist/${slug}?sort=${sort}&page=${page}`}
              label={`More from ${name}, more pages`}
              page={catalogue.page}
              pageCount={catalogue.pageCount}
            />
          </section>
        ) : undefined}

        <footer className="log-plate-footer">
          <Link to="/artists">All artists</Link>
          <Link to="/">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}
