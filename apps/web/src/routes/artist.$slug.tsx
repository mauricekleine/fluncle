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
  siX,
  siYoutube,
} from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { StoryNotFoundState } from "@/components/stories/stories-states";
import { TrackArtwork } from "@/components/track-artwork";
import { type ArtistSocialPlatform } from "@/lib/artist-socials";
import { siteUrl } from "@/lib/fluncle-links";
import { formatDateLong } from "@/lib/format";
import { jsonLdScript } from "@/lib/json-ld";
import { artistBreadcrumbsJsonLd, musicGroupJsonLd } from "@/lib/log-schema";
import { artistTitleLine } from "@/lib/log-prose";
import { spotifyAlbumImageAtSize } from "@/lib/media";
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
      dossier: ArtistDossier;
      findings: TrackListItem[];
      indexable: boolean;
      name: string;
      slug: string;
      socials: ArtistSocialLink[];
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
  twitter: "X",
  youtube: "YouTube",
};

// Resolve the artist page's data. Extracted from the server fn so the
// indexability decision is unit-testable (see artist-page.test.ts). The grid's
// `findings` come from `getFindingsByArtist` (which has an `artists_json`
// fallback so a pre-backfill artist still shows its covers), but the `noindex`
// gate + JSON-LD key off `countArtistFindings` — the SAME pure `track_artists`
// join the sitemap + `/artists` index use — so an indexable page is never
// orphaned from the sitemap/index during the backfill window (RFC §3).
export async function resolveArtistPageData(slug: string): Promise<ArtistPageData> {
  const artist = await getArtistBySlug(slug);

  if (!artist) {
    return { status: "missing" };
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
    gridFindings.map((finding) => ({
      addedAt: finding.addedAt,
      bpm: finding.bpm,
      key: finding.key,
    })),
  );

  return {
    dossier: { ...signature, findingCount: gridFindings.length, neighbours },
    findings,
    // Thin-content gate: index only at ≥3 coordinate-bearing findings (counted via
    // the canonical `track_artists` join, the same source as the sitemap + index);
    // below that the page still serves 200 but is noindex + out of the sitemap.
    indexable: canonicalFindingCount >= ARTIST_INDEX_MIN_FINDINGS,
    mbid: artist.mbid,
    name: artist.name,
    slug: artist.slug,
    socials,
    spotifyUrl: artist.spotifyUrl,
    status: "found",
    wikidataQid: artist.wikidataQid,
  };
}

const fetchArtist = createServerFn({ method: "GET" })
  .validator((data: { slug: string }) => data)
  .handler(({ data: { slug } }): Promise<ArtistPageData> => resolveArtistPageData(slug));

// The first-person voice frame — Fluncle framing HIS relationship to the findings,
// never a fabricated bio (VOICE.md); active voice, said-not-written. When he has a
// first-found date it opens the dossier the logbook way ("first crossed his path
// on …"); the bare-count line is the pre-dossier fallback.
function artistSignatureLine(name: string, dossier: ArtistDossier): string {
  const { findingCount, firstFoundAt } = dossier;

  if (findingCount === 0) {
    return "Nothing logged from this one yet.";
  }

  if (!firstFoundAt) {
    return findingCount === 1
      ? "I've found just one of their tunes so far. Play it loud."
      : `I've found ${findingCount} of their tunes so far. Have a dig.`;
  }

  const when = formatDateLong(firstFoundAt);

  if (findingCount === 1) {
    return `I first crossed ${name}'s path on ${when}. Just the one so far. Play it loud.`;
  }

  return `I first crossed ${name}'s path on ${when}, and I've logged ${findingCount} of their tunes since. Have a dig.`;
}

// The tempo field's value — the band plus its median, or a single figure when every
// finding shares a tempo. Plain, logbook-flavoured; "to" (not a dash) keeps the range
// clear of the sanctioned Artist — Title em dash (VOICE.md).
function tempoLine(bpm: ArtistDossier["bpm"]): string | undefined {
  if (!bpm) {
    return undefined;
  }

  const min = Math.round(bpm.min);
  const max = Math.round(bpm.max);

  if (min === max) {
    return `${min} BPM`;
  }

  return `${min} to ${max} BPM, mostly ${Math.round(bpm.median)}`;
}

function artistHead(loaderData: ArtistPageData | undefined) {
  if (loaderData?.status !== "found") {
    return {};
  }

  const { findings, indexable, name, slug, socials, mbid, spotifyUrl, wikidataQid } = loaderData;
  const pageUrl = `${siteUrl}/artist/${slug}`;
  // The <title>/meta stay honestly-plain third-person (the Narrator rule); the
  // first person lives only in the on-page voice frame.
  const title = `${name} · Fluncle's Findings`;
  const description =
    findings.length > 0
      ? `Every ${name} banger Fluncle has found and logged in the Galaxy, ${findings.length} so far, each with a coordinate.`
      : `${name} in Fluncle's Galaxy.`;
  const coverFinding = findings[0];
  const imageUrl =
    (coverFinding ? spotifyAlbumImageAtSize(coverFinding.albumImageUrl, "large") : undefined) ??
    `${siteUrl}/fluncle-cover.png`;

  const musicGroup = musicGroupJsonLd(
    {
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
    links: [{ href: pageUrl, rel: "canonical" }],
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
  loader: async ({ params }): Promise<ArtistPageData> => {
    const data = await fetchArtist({ data: { slug: params.slug } });

    if (data.status === "missing") {
      throw notFound();
    }

    return data;
  },
  head: ({ loaderData }: { loaderData?: ArtistPageData }) => artistHead(loaderData),
  component: ArtistPage,
  notFoundComponent: StoryNotFoundState,
});

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

  if (data.status !== "found") {
    return null;
  }

  const { dossier, findings, name, socials } = data;
  const grid = findings.filter((finding) => finding.logId);
  const tempo = tempoLine(dossier.bpm);

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title artist-name">{name}</h1>
          <p className="log-index-intro">{artistSignatureLine(name, dossier)}</p>

          {socials.length > 0 ? (
            <nav aria-label={`${name} elsewhere`} className="artist-socials">
              {socials.map((social) => (
                <SocialLink key={social.platform} social={social} />
              ))}
            </nav>
          ) : undefined}
        </header>

        {tempo || dossier.keys.length > 0 ? (
          <dl className="log-fields artist-signature">
            {tempo ? (
              <div className="log-field">
                <dt>Tempo</dt>
                <dd>{tempo}</dd>
              </div>
            ) : undefined}
            {dossier.keys.length > 0 ? (
              <div className="log-field">
                <dt>{dossier.keys.length === 1 ? "Key" : "Keys"}</dt>
                <dd>{dossier.keys.join(", ")}</dd>
              </div>
            ) : undefined}
          </dl>
        ) : undefined}

        {dossier.neighbours.length > 0 ? (
          <nav aria-label="Artists in the same sector" className="artist-sector">
            <p className="artist-sector-label">Same sector</p>
            <ul className="artist-sector-list">
              {dossier.neighbours.map((neighbour) => (
                <li key={neighbour.slug}>
                  <Link
                    className="artist-sector-link"
                    params={{ slug: neighbour.slug }}
                    to="/artist/$slug"
                  >
                    {neighbour.name}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : undefined}

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
                      src={spotifyAlbumImageAtSize(finding.albumImageUrl, "large")}
                    />
                    <span className="artist-grid-line">{artistTitleLine(finding)}</span>
                  </Link>
                </li>
              ) : null,
            )}
          </ul>
        )}

        <footer className="log-plate-footer">
          <Link to="/artists">All artists</Link>
          <Link to="/">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}
