// The album page's server-side resolution, lifted out of `album.$slug.tsx` — the
// `-findings-data.ts` / `-artist-page-data.ts` sibling-module pattern.
//
// WHY IT IS NOT IN THE ROUTE FILE. A route's `loader`, `head` and `validateSearch` live in the
// route's CRITICAL half: only the `component` is auto-split into a lazy chunk, so everything
// else the route module reaches STATICALLY lands in the eager entry chunk that every page —
// homepage included — downloads before first paint. An exported resolver referenced outside a
// `createServerFn().handler()` boundary keeps its `lib/server/**` imports alive in the client
// build (TanStack Start's own import-protection guide calls this the leaky-helper case), and
// those imports carry `getDb` → `@libsql/client` + `drizzle-orm` + all of `db/schema.ts`.
// Measured on the built bundle, the three graph routes doing this put ~232 KB of rendered
// server-only modules into that eager chunk.
//
// So the resolver lives here and the route reaches it by a DYNAMIC import inside the handler —
// a body the client build removes wholesale. The route keeps only `import type`, which erases.
// The function stays exported and side-effect-free, so `-graph-pages.test.ts` drives it
// directly against a real database exactly as before.

import { ALBUM_INDEX_MIN_TRACKS, getAlbumBySlug } from "@/lib/server/albums";
import { type ArtistChip, listArtistsByAlbum } from "@/lib/server/artists";
import { getLabelForAlbum, type LabelRecord } from "@/lib/server/labels";
import {
  type CatalogueTrackItem,
  getFindingsByAlbum,
  listCatalogueTracksByAlbum,
  type TrackListItem,
} from "@/lib/server/tracks";

export type AlbumPageData =
  | {
      artists: ArtistChip[];
      /**
       * The album's voiced factual bio — a short paragraph beneath the masthead, undefined until
       * one is authored (lib/server/bio.ts). The page renders it only when present.
       */
      bio: string | undefined;
      /** Uncertified tracks on this album. Empty until the catalogue lands. */
      catalogue: CatalogueTrackItem[];
      /**
       * The label's own catalogue number for this record (`albums.discogs_catno`) — the code
       * printed on the sleeve, read off the Discogs release Fluncle already resolved. The page
       * prints it as a quiet fact beside the label and stamps it into the MusicRelease JSON-LD as
       * `catalogNumber`. Undefined until the Discogs facts sweep has ruled on the record.
       */
      catalogNumber: string | undefined;
      coverImageUrl: string | undefined;
      findings: TrackListItem[];
      indexable: boolean;
      label: LabelRecord | undefined;
      name: string;
      /** The record's earliest track release date → the MusicAlbum's `datePublished`. */
      releaseDate: string | undefined;
      /** The MusicBrainz release-group MBID → the MusicAlbum's `sameAs`. */
      releaseGroupMbid: string | undefined;
      slug: string;
      status: "found";
      /** The album's barcode → the MusicAlbum's `gtin13`. */
      upc: string | undefined;
    }
  | { status: "missing" };

/**
 * Resolve the album page's data. Extracted from the server fn so the indexability decision
 * is unit-testable (see -graph-pages.test.ts), the `resolveArtistPageData` precedent.
 *
 * A record earns a page on its CONTENT, exactly as a label does (`/label/<slug>` carries the
 * long version of this note): a tracklist is a real page, and what keeps a stub out of the index
 * is the thin-content gate below, counting TOTAL renderable tracks. A crawl-minted, findings-free
 * record has an `albums` row (minted inline at crawl time) and renders on its tracklist, indexing
 * once it clears the floor — exactly as a discovered label does on its releases.
 *
 * A slug with no `albums` row at all is still MISSING, and still 404s.
 */
export async function resolveAlbumPageData(slug: string): Promise<AlbumPageData> {
  const album = await getAlbumBySlug(slug);

  if (!album) {
    return { status: "missing" };
  }

  const [findings, catalogue, artists, label] = await Promise.all([
    getFindingsByAlbum(album.id),
    listCatalogueTracksByAlbum(album.id),
    listArtistsByAlbum(album.id),
    getLabelForAlbum(album.id),
  ]);

  return {
    artists,
    bio: album.bio,
    catalogNumber: album.discogsCatno,
    catalogue: catalogue.tracks,
    // The record's cover is its freshest finding's album art — never invented, never
    // re-hosted (the `i.scdn.co` attribution-by-link precedent). A record with no finding
    // has no cover of its own to show, and shows none.
    coverImageUrl: findings[0]?.albumImageUrl,
    findings,
    // Thin-content gate: index only past ALBUM_INDEX_MIN_TRACKS RENDERABLE tracks — the
    // findings PLUS the quieter rows, because both are real content on the page. The
    // sitemap keys off the same sum (the entity's TRUE catalogue total, never the
    // rendered slice), so an indexable page is never orphaned from it.
    indexable: findings.length + catalogue.total >= ALBUM_INDEX_MIN_TRACKS,
    label,
    name: album.name,
    // The album's identity anchors + its earliest release date, read in the same `getAlbumBySlug`
    // pass (the `datePublished`/`sameAs`/`gtin13` the JSON-LD emits). Undefined when the record
    // carries none.
    releaseDate: album.releaseDate,
    releaseGroupMbid: album.releaseGroupMbid,
    slug: album.slug,
    status: "found",
    upc: album.upc,
  };
}
