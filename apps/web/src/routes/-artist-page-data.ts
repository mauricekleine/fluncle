// The artist page's server-side resolution, lifted out of `artist.$slug.tsx` — the
// `-findings-data.ts` sibling-module pattern, and the same split `-album-page-data.ts` and
// `-label-page-data.ts` carry. That file holds the long note on WHY: a route's loader/head
// live in the route's critical half, so a resolver referenced there keeps its `lib/server/**`
// imports — and the `getDb` → `@libsql/client` + `drizzle-orm` + `db/schema.ts` chain behind
// them — alive in the eager browser chunk every page downloads before first paint.
//
// The route reaches this by a DYNAMIC import inside its handler and by `import type`, so the
// whole chain stays server-side. `-artist-page.test.ts` drives the resolver directly, as before.

import {
  type ArtistNeighbour,
  type ArtistSignature,
  getArtistNeighbours,
  summarizeArtistSignature,
} from "@/lib/server/artist-dossier";
import {
  ARTIST_INDEX_MIN_FINDINGS,
  type ArtistSocialLink,
  getPublicArtistBySlug,
  getPublicArtistAliasNames,
  getPublicArtistSocials,
} from "@/lib/server/artists";
import {
  CataloguePageOutOfRangeError,
  type CatalogueGroupPage,
  type CatalogueRecord,
  type CatalogueSort,
  type UpcomingTrackPage,
} from "@/lib/catalogue";
import { listArtistCatalogue, listArtistUpcoming } from "@/lib/server/catalogue-groups";
import { releaseTodayUtc } from "@/lib/server/release-day";
import { countRenderedArtistTracks, publicEntityIndexable } from "@/lib/server/entity-indexability";
import { getFindingsByArtist, type TrackListItem } from "@/lib/server/tracks";

// The socials row's shape travels with the page data, so the route renders it without
// importing from `lib/server/**` itself.
export type { ArtistSocialLink };

// The dossier bundled onto the page data: the pure signature (first-found, tempo,
// keys) plus the "same sector" neighbours. Assembled in the loader so the whole
// page arrives in one SSR payload (no client round-trip), matching the route's
// existing loader-only shape.
type ArtistDossier = ArtistSignature & {
  findingCount: number;
  neighbours: ArtistNeighbour[];
};

export type ArtistPageData =
  | {
      // The artist's PUBLIC alternate names (the MusicBrainz identity layer) — the trusted MB/operator
      // aliases, fed to the MusicGroup JSON-LD's `alternateName`. Empty when the artist has none.
      alternateNames: string[];
      // The artist's voiced bio — a short paragraph beneath the dateline, undefined until one
      // is authored (lib/server/bio.ts). The masthead renders it only when present.
      bio: string | undefined;
      // The rest of this artist's catalogue — their crawled tracks grouped into records, one
      // page of it (`catalogue-groups.ts` owns the bound). Empty until the catalogue lands.
      catalogue: CatalogueGroupPage<CatalogueRecord>;
      dossier: ArtistDossier;
      findings: TrackListItem[];
      upcoming: UpcomingTrackPage;
      // The artist's OWN portrait (owned avatar master, else Spotify image), or undefined. Preferred
      // for og:image + the MusicGroup's `image`, and rendered in the masthead. Falls back to the
      // freshest finding's album cover only when the artist carries no avatar of their own.
      // The artist entity's id — the key a signed-in user's watch files against (D2a).
      id: string;
      imageUrl: string | undefined;
      indexable: boolean;
      name: string;
      slug: string;
      socials: ArtistSocialLink[];
      sort: CatalogueSort;
      status: "found";
      // The identity graph the JSON-LD's sameAs draws on (KG anchors). Discogs + Last.fm are
      // MB-relation-sourced identities with no rendered link — schema only.
      discogsUrl: string | undefined;
      lastfmUrl: string | undefined;
      mbid: string | undefined;
      spotifyUrl: string | undefined;
      wikidataQid: string | undefined;
    }
  | { status: "missing" };

// Resolve the artist page's data. Extracted from the server fn so the indexability decision is
// unit-testable (see -artist-page.test.ts). An artist earns a page on its CONTENT, exactly as a
// label/album does: a `getPublicArtistBySlug` row renders, and the thin-content gate below (not a
// certified-finding gate) decides whether it indexes. The grid's `findings` come from
// `getFindingsByArtist` (which has an `artists_json` fallback so a pre-backfill artist still shows
// its covers). The indexability gate counts the same visible edge and bounded fallback members
// as the sitemap, including Upcoming rows.
export async function resolveArtistPageData(
  slug: string,
  sort: CatalogueSort,
  page: number,
  upcomingPage = 1,
): Promise<ArtistPageData> {
  const today = releaseTodayUtc(new Date());
  const artist = await getPublicArtistBySlug(slug);

  if (!artist) {
    return { status: "missing" };
  }

  // Ride the catalogue read in the same parallel wave as the finding/social/neighbour
  // reads — all key only off `artist.id` and are mutually independent. A page past the
  // end of the pager throws `CataloguePageOutOfRangeError`; map ONLY that to null here so it
  // no longer blocks the batch, and 404 once the wave settles. Any other error still throws.
  const cataloguePromise = listArtistCatalogue(artist.id, sort, page, today).catch(
    (error: unknown): CatalogueGroupPage<CatalogueRecord> | null => {
      if (error instanceof CataloguePageOutOfRangeError) {
        return null;
      }

      throw error;
    },
  );

  const [catalogue, findings, socials, neighbours, alternateNames, upcoming, renderedCount] =
    await Promise.all([
      cataloguePromise,
      getFindingsByArtist(artist.id, artist.name, today),
      getPublicArtistSocials(artist.id),
      getArtistNeighbours(artist.id),
      // The trusted MB/operator aliases — keyed off `artist.id`, mutually independent, so it rides
      // the same parallel wave as the finding/social/neighbour reads (the MusicBrainz identity layer).
      getPublicArtistAliasNames(artist.id),
      listArtistUpcoming(artist.id, today, upcomingPage).catch(
        (error: unknown): UpcomingTrackPage | null => {
          if (error instanceof CataloguePageOutOfRangeError) {
            return null;
          }
          throw error;
        },
      ),
      countRenderedArtistTracks(artist.id, artist.name, today),
    ]);

  if (catalogue === null || upcoming === null) {
    // A page past the end of the pager is genuinely not-found, not a 500 — a crawler or a
    // hand-typed `?page=99` on a 3-page artist gets an honest 404, never an empty page that
    // duplicates page 1's content under a new URL.
    return { status: "missing" };
  }

  // The signature is pure over the findings already loaded for the grid (no extra
  // query); the neighbours came from the corpus-wide embedding pass above.
  const gridFindings = findings.filter((finding) => finding.logId);
  const signature = summarizeArtistSignature(
    gridFindings.map((finding) => ({ addedAt: finding.addedAt })),
  );

  return {
    alternateNames,
    bio: artist.bio,
    catalogue,
    discogsUrl: artist.discogsUrl,
    dossier: { ...signature, findingCount: gridFindings.length, neighbours },
    findings,
    id: artist.id,
    imageUrl: artist.imageUrl,
    // The rendered-membership count includes Upcoming and is the sitemap's gate as well.
    indexable: publicEntityIndexable(renderedCount, ARTIST_INDEX_MIN_FINDINGS),
    lastfmUrl: artist.lastfmUrl,
    mbid: artist.mbid,
    name: artist.name,
    slug: artist.slug,
    socials,
    sort,
    spotifyUrl: artist.spotifyUrl,
    status: "found",
    upcoming,
    wikidataQid: artist.wikidataQid,
  };
}
