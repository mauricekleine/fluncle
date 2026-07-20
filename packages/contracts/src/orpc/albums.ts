// The `albums` domain contract module — public album-entity reads. Follows the
// `artists.ts` pattern: a paginated list op and a by-slug get op, both public reads.
// `list_albums` serves the SAME unified `/albums` index the web page does — every album
// Fluncle holds, certified and catalogue alike, that clears the thin-content floor;
// `get_album` resolves any album that has a page (below-floor records included).

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * A public album list item — the minimal row the list and get ops emit. The public
 * identifier is `slug` (the internal surrogate id never crosses the wire).
 * `coverImageUrl` is the owned ≤1200² cover master when one has been resolved, else the
 * record's captured cover art. `findingCount` counts published findings on the album;
 * `certified` is `findingCount > 0`; `trackCount` is its renderable tracks (findings plus the
 * quieter catalogue rows).
 */
export const AlbumListItemSchema = z
  .object({
    certified: z.boolean(),
    coverImageUrl: z.string().optional(),
    findingCount: z.number(),
    name: z.string(),
    slug: z.string(),
    trackCount: z.number(),
  })
  .meta({ id: "AlbumListItem" });

/**
 * A single album's full read — the list row plus the album's own identity fields
 * (release date and the off-catalogue MusicBrainz/UPC anchors), each present only when
 * the album carries it. No track list: the read stays lean, and the tracklist lives on
 * the web `/album/<slug>` page.
 */
export const AlbumDetailSchema = z
  .object({
    bio: z.string().optional(),
    certified: z.boolean(),
    coverImageUrl: z.string().optional(),
    findingCount: z.number(),
    name: z.string(),
    releaseDate: z.string().optional(),
    releaseGroupMbid: z.string().optional(),
    slug: z.string(),
    trackCount: z.number(),
    upc: z.string().optional(),
  })
  .meta({ id: "AlbumDetail" });

/**
 * `list_albums` → `GET /albums` (operationId `listAlbums`).
 *
 * The unified `/albums` index — every album Fluncle holds that clears the thin-content floor,
 * ordered alphabetically by name, one page at a time. This is the SAME index the `/albums` web
 * page serves. `page` is a 1-based tolerant string query param (default 1); the page size is
 * fixed. Contract-only oRPC (no route file under /api/v1/albums). The response is
 * `{ ok: true, albums, page, pageCount, total }`.
 */
export const listAlbums = oc
  .route({
    method: "GET",
    operationId: "listAlbums",
    path: "/albums",
    summary: "List every album Fluncle holds, A to Z, one page at a time",
    tags: ["Albums"],
  })
  .input(z.object({ page: z.string().optional() }))
  .output(
    z.object({
      albums: z.array(AlbumListItemSchema),
      ok: z.literal(true),
      page: z.number(),
      pageCount: z.number(),
      total: z.number(),
    }),
  );

/**
 * `get_album` → `GET /albums/{slug}` (operationId `getAlbum`).
 *
 * One album by its unique slug, wrapped in `{ ok: true, album }`. Resolves any album that has a
 * page — a below-floor album the list omits still renders on its `/album/<slug>` page — so get is
 * intentionally wider than the list index. A slug that matches no album is a 404.
 */
export const getAlbum = oc
  .route({
    method: "GET",
    operationId: "getAlbum",
    path: "/albums/{slug}",
    summary: "Get an album by slug",
    tags: ["Albums"],
  })
  .input(z.object({ slug: z.string() }))
  .output(z.object({ album: AlbumDetailSchema, ok: z.literal(true) }));

/** The `albums` domain's ops, merged into the root contract by `./index.ts`. */
export const albumsContract = {
  get_album: getAlbum,
  list_albums: listAlbums,
};
