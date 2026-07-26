import { GlobeSimpleIcon } from "@phosphor-icons/react";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  siBandcamp,
  siBeatport,
  siBluesky,
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
import { FindingsGrid } from "@/components/graph-sections";
import { GraphLink } from "@/components/graph-link";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { WatchButton } from "@/components/watch-button";
import { type ArtistSocialPlatform } from "@/lib/artist-socials";
import { entityFreshChannel } from "@/lib/fresh-feed-rss";
import { siteUrl } from "@/lib/fluncle-links";
import { jsonLdScript } from "@/lib/json-ld";
import { artistBreadcrumbsJsonLd, musicGroupJsonLd } from "@/lib/log-schema";
import { bioMetaDescription } from "@/lib/meta-description";
import { albumCoverAtSize } from "@/lib/media";
import { type CatalogueSort } from "@/lib/catalogue";
import { type ArtistPageData, type ArtistSocialLink } from "./-artist-page-data";

// A confirmed/auto social — the brand mark + a plain label, from simple-icons
// (never a Phosphor glyph for a brand). `homepage` is not a brand, so it takes the
// Phosphor globe (an interface icon) — DESIGN.md "Iconography".
const SOCIAL_META: Record<
  Exclude<ArtistSocialPlatform, "homepage">,
  { path: string; title: string }
> = {
  bandcamp: siBandcamp,
  beatport: siBeatport,
  bluesky: siBluesky,
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
  bluesky: "Bluesky",
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

// The artist page: a dark, cover-led Instagram-style grid of Fluncle's findings
// for one artist, under a plate masthead (name + a Fluncle-voice frame + the
// confirmed socials row). Held to DESIGN.md — a Fluncle cover grid, not a bright
// streaming clone. The @id graph + MusicGroup/sameAs JSON-LD make it the entity's
// home for crawlers + AI answer-engines (Unit 3, artist-relationship RFC §3).

// The resolver arrives by a DYNAMIC import inside the handler, and its types by `import type`,
// so this route module never statically references `lib/server/**` — see `-artist-page-data.ts`.
const fetchArtist = createServerFn({ method: "GET" })
  .validator((data: { page: number; slug: string; sort: CatalogueSort }) => data)
  .handler(async ({ data: { page, slug, sort } }): Promise<ArtistPageData> => {
    const { resolveArtistPageData } = await import("./-artist-page-data");

    return resolveArtistPageData(slug, sort, page);
  });

function artistHead(loaderData: ArtistPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  const {
    alternateNames,
    bio,
    catalogue,
    findings,
    imageUrl: artistImageUrl,
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
  const title = `${name} · Fluncle`;
  // The factual bio is the honest, UNIQUE description when one is authored — the same objective
  // paragraph the page prints, trimmed to the meta cap. Absent (the bio backfill is in flight for
  // many artists), it falls back to the templated line verbatim, so nothing regresses. This one
  // string flows to meta + og + twitter below, so all three go unique together.
  const description =
    bio !== undefined
      ? bioMetaDescription(bio)
      : findings.length > 0
        ? `Drum & bass tracks by ${name} that Fluncle recommends, ${findings.length} so far, with the labels and releases behind them.`
        : `Drum & bass tracks by ${name}, with the labels and releases behind them.`;
  // The artist's OWN portrait leads: its owned avatar master (or Spotify image) is the entity's
  // true image. Only when it has none does the page fall back to its freshest finding's cover, then
  // the site cover as the floor. This one URL flows to og:image, twitter:image, and MusicGroup.image.
  const coverFinding = findings[0];
  const imageUrl =
    artistImageUrl ??
    (coverFinding ? albumCoverAtSize(coverFinding.albumImageUrl, "large") : undefined) ??
    `${siteUrl}/fluncle-cover.png`;

  const musicGroup = musicGroupJsonLd(
    {
      alternateNames,
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
      // RSS discovery: this artist's new-releases feed (the 30-day window, this artist only).
      // The bare `/artist/<slug>/fresh.xml`, never the paged catalogue URL.
      {
        href: `${siteUrl}/artist/${slug}/fresh.xml`,
        rel: "alternate",
        title: entityFreshChannel("artist", name).title,
        type: "application/rss+xml",
      },
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

// The artist page opens on the artist's LATEST RELEASE — the dropdown's "recent" key ("Latest
// release"), not the shared A–Z default the label/album reads (`CATALOGUE_SORT_DEFAULT`). An
// artist page is read like a discography: the newest record is what a visitor came for, so it
// leads on the first (param-free) load and the dropdown reflects it. An explicit `?sort=name`
// still round-trips to A–Z. Kept an artist-scoped constant (not a flip of the shared default) so
// the crawler-stability argument the shared default is built on still holds for the label pages.
export const ARTIST_CATALOGUE_SORT_DEFAULT: CatalogueSort = "recent";

// Route options follow TanStack's create-route-property-order (each step feeds the
// next's inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/artist/$slug")({
  validateSearch: (search: Record<string, unknown>): ArtistSearch => ({
    page: pageParam(search["page"]),
    sort: sortParam(search["sort"]),
  }),
  // Defaults land HERE, so the loader always gets a real page + sort while the URL keeps them
  // implicit (a bare `/artist/<slug>` is the canonical, crawlable view). `validateSearch` has
  // already narrowed `sort` to a known key or undefined, so an absent one falls to the artist
  // default — latest release first.
  loaderDeps: ({ search }) => ({
    page: search.page ?? 1,
    sort: search.sort ?? ARTIST_CATALOGUE_SORT_DEFAULT,
  }),
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

  const { bio, catalogue, dossier, findings, id, imageUrl, name, slug, socials, sort } = data;

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          {/* The entity's own portrait, above its name — the owned avatar master when resolved,
              a quiet monogram tile otherwise (ArtistAvatar's fallback). The masthead slot is
              `min(5rem, 40%)` — 80 CSS px, 160 on a 2× screen — so it takes the 300 rung; the 640
              the DTO hands out is the og:image size, not this one. */}
          <ArtistAvatar
            className="artist-masthead-avatar"
            name={name}
            src={albumCoverAtSize(imageUrl, "medium")}
          />
          <h1 className="log-coordinate log-index-title artist-name">{name}</h1>
          {/* The dossier bio is the masthead's prose — the reference register (the Three Areas
              Rule; the first-person signature line is retired). Rendered once authored. */}
          {bio ? <p className="log-index-bio">{bio}</p> : undefined}
          {/* The quiet watch control — a signed-in user keeps an eye on this artist. Renders
              nothing for a signed-out visitor (the account never gates the page) — no wrapper, so
              the null face leaves no empty grid item in the masthead. */}
          <WatchButton entityId={id} kind="artist" name={name} />
        </header>

        {/* The findings lead: the logged tracks are the primary entity in the Galaxy — the artist
            page frames THEM. Shared with the label/album graph pages via FindingsGrid: an artist
            with no coordinate-bearing findings renders NOTHING here — no grid, no heading, no
            empty-state apology. Its catalogue tracklist below and its masthead bio carry the page,
            exactly as a crawler-discovered label's does (graph-sections.tsx header: a page with no
            findings is a page about something else). Socials and kin follow. */}
        <FindingsGrid findings={findings} />

        {socials.length > 0 ? (
          <nav aria-label={`Follow ${name}`} className="artist-follow">
            <h2 className="artist-similar-label">Follow {name}</h2>
            <div className="artist-socials">
              {socials.map((social) => (
                <SocialLink key={social.platform} social={social} />
              ))}
            </div>
          </nav>
        ) : undefined}

        {dossier.neighbours.length > 0 ? (
          <nav aria-label="Similar artists" className="artist-similar">
            <h2 className="artist-similar-label">Similar artists</h2>
            <ul className="artist-similar-list">
              {dossier.neighbours.map((neighbour) => (
                <li key={neighbour.slug}>
                  {/* The same graph link as everywhere else, in its chip skin — hovering a kin
                      artist previews them before you commit to the click. A neighbour Fluncle
                      never certified renders UNLIT (DESIGN.md's Unlit Rule): the avatar sits a
                      step down and the chip stays cool — listed, never introduced, no gold. Focus
                      stays loud. */}
                  <GraphLink
                    className={
                      neighbour.certified
                        ? "artist-similar-link"
                        : "artist-similar-link artist-similar-link--unlit"
                    }
                    kind="artist"
                    slug={neighbour.slug}
                    variant="chip"
                  >
                    <ArtistAvatar
                      className={
                        neighbour.certified
                          ? "artist-similar-avatar"
                          : "artist-similar-avatar artist-similar-avatar--unlit"
                      }
                      name={neighbour.name}
                      // A 1.5rem chip avatar — 48 device px at 2× — takes the 64 rung, never the
                      // 640 master the DTO hands out (26× the pixels this tile can show).
                      src={albumCoverAtSize(neighbour.imageUrl, "small")}
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
          <section aria-labelledby="artist-catalogue-heading" className="catalogue-section">
            {/* The section's name, promoted from an `aria-label` to a real H2 so the heading
                outline runs H1 → H2 → H3 (the record names inside are H3s, and a page that
                jumps H1 → H3 fails `heading-order`). It stays visually hidden, so nothing about
                the page's quiet, headingless look changes — and the string is the same one the
                aria-label already carried: it names the RECORDS, never the tier they belong to
                (graph-sections.tsx, the unnamed tier). */}
            <h2 className="sr-only" id="artist-catalogue-heading">
              More from {name}
            </h2>
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
          <Link to="/">Home</Link>
        </footer>
      </article>
    </main>
  );
}
