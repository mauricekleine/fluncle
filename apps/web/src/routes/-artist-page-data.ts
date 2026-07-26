// The artist page's server-side resolution, lifted out of `artist.$slug.tsx` — the
// `-home-data.ts` sibling-module pattern, and the same split `-album-page-data.ts` and
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
  countArtistFindings,
  getArtistBySlug,
  getPublicArtistAliasNames,
  getPublicArtistSocials,
} from "@/lib/server/artists";
import {
  CataloguePageOutOfRangeError,
  type CatalogueGroupPage,
  type CatalogueRecord,
  type CatalogueSort,
} from "@/lib/catalogue";
import { listArtistCatalogue } from "@/lib/server/catalogue-groups";
import { getFindingsByArtist, type TrackListItem } from "@/lib/server/tracks";

// The socials row's shape travels with the page data, so the route renders it without
// importing from `lib/server/**` itself.
export type { ArtistSocialLink };

// The dossier bundled onto the page data: the pure signature (first-found, tempo,
// keys) plus the "same sector" neighbours. Assembled in the loader so the whole
// page arrives in one SSR payload (no client round-trip), matching the route's
// existing loader-only shape.
export type ArtistDossier = ArtistSignature & {
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
      // The identity graph the JSON-LD's sameAs draws on (KG anchors).
      mbid: string | undefined;
      spotifyUrl: string | undefined;
      wikidataQid: string | undefined;
    }
  | { status: "missing" };

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

  // Ride the catalogue read in the SAME parallel wave as the four finding/social/neighbour
  // reads — all five key only off `artist.id` and are mutually independent. A page past the
  // end of the pager throws `CataloguePageOutOfRangeError`; map ONLY that to null here so it
  // no longer blocks the batch, and 404 once the wave settles. Any other error still throws.
  const cataloguePromise = listArtistCatalogue(artist.id, sort, page).catch(
    (error: unknown): CatalogueGroupPage<CatalogueRecord> | null => {
      if (error instanceof CataloguePageOutOfRangeError) {
        return null;
      }

      throw error;
    },
  );

  const [catalogue, findings, socials, canonicalFindingCount, neighbours, alternateNames] =
    await Promise.all([
      cataloguePromise,
      getFindingsByArtist(artist.id, artist.name),
      getPublicArtistSocials(artist.id),
      countArtistFindings(artist.id),
      getArtistNeighbours(artist.id),
      // The trusted MB/operator aliases — keyed off `artist.id`, mutually independent, so it rides
      // the same parallel wave as the four finding/social/neighbour reads (the MusicBrainz identity layer).
      getPublicArtistAliasNames(artist.id),
    ]);

  if (catalogue === null) {
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
    dossier: { ...signature, findingCount: gridFindings.length, neighbours },
    findings,
    id: artist.id,
    imageUrl: artist.imageUrl,
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
