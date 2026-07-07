// The `admin-artists` domain contract module — artist entity operations (artist-
// relationship RFC). Follows the `admin-backfills` pattern for backfill; the
// `resolve_artist` op adds the social-identity resolution surface.
//
//   - `backfill_artists` — agent tier (`adminAuth`): re-fetches `/tracks/{trackId}`
//     for existing findings that predate the artists/track_artists tables and upserts
//     the entity rows. Idempotent: findings that already have a track_artists row are
//     skipped. The CLI loops the cursor until null.
//
//   - `resolve_artist` — agent tier (`adminAuth`): triggers MB url-rels walk +
//     Firecrawl /v2/extract gap-fill for one artist. MB rows → status=auto (trusted);
//     Firecrawl rows → status=candidate (operator-confirm before public). The on-box
//     `fluncle-artist-sweep` cron drives this in bulk.
//
// Input params are tolerant optional strings (the live route convention for
// `limit`/`dryRun`/`cursor`): the handler parses + clamps them, never 400s on a
// malformed value. `inputStructure: "detailed"` exposes the query string so the
// params reach the handler from a bodyless POST.

import { oc } from "@orpc/contract";
import * as z from "zod";

/** A failed-artist row (`{ logId, error }`). */
const ArtistsBackfillFailedSchema = z
  .object({
    error: z.string(),
    logId: z.string(),
  })
  .meta({ id: "ArtistsBackfillFailed" });

/**
 * `backfill_artists` → `POST /admin/backfill/artists` (operationId
 * `backfillArtists`).
 *
 * Agent tier (`adminAuth`). One bounded, cursor-resumable pass over published
 * findings missing a `track_artists` row. For each, re-fetches the Spotify track
 * metadata and upserts `artists` + `track_artists`. Returns `{ ok, dryRun, upserted,
 * upsertedCount, skipped, skippedCount, failed, failedCount, nextCursor }`.
 */
export const backfillArtists = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillArtists",
    path: "/admin/backfill/artists",
    summary: "Back-fill artists + track_artists for existing findings (batched)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        cursor: z.string().optional(),
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      dryRun: z.boolean(),
      failed: z.array(ArtistsBackfillFailedSchema),
      failedCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      skipped: z.array(z.string()),
      skippedCount: z.number(),
      upserted: z.array(z.string()),
      upsertedCount: z.number(),
    }),
  );

// The platform + source enums MUST stay in lockstep with the resolver's
// `ArtistSocialPlatform` + `ResolvedSocial.source` in
// `apps/web/src/lib/server/artist-resolution.ts` — the resolver is the source of
// truth for the shape this op returns. (`wikidata` is classified during the MB
// walk but routed to the `wikidataQid` KG anchor, not into `socials`.)
/** A resolved social from the MB url-rels walk or the Firecrawl gap-fill. */
export const ResolvedSocialSchema = z
  .object({
    platform: z.enum([
      "bandcamp",
      "facebook",
      "homepage",
      "instagram",
      "mixcloud",
      "soundcloud",
      "spotify",
      "tiktok",
      "twitter",
      "youtube",
    ]),
    source: z.enum(["musicbrainz", "firecrawl"]),
    url: z.string().url(),
  })
  .meta({ id: "ResolvedSocial" });

/**
 * `resolve_artist` → `POST /admin/artists/{artistId}/resolve` (operationId
 * `resolveArtist`).
 *
 * Agent tier (`adminAuth`). Triggers the MB url-rels walk + Firecrawl gap-fill
 * for one artist. Returns the resolved socials, mbid, wikidata QID, and a
 * `rateLimited` flag if MB throttled mid-walk. The on-box cron calls this in a
 * loop; the CLI exposes it for ad-hoc resolution.
 */
export const resolveArtist = oc
  .route({
    method: "POST",
    operationId: "resolveArtist",
    path: "/admin/artists/{artistId}/resolve",
    summary: "Resolve an artist's social identity (MB + Firecrawl gap-fill)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      artistId: z.string(),
    }),
  )
  .output(
    z.object({
      artistId: z.string(),
      mbid: z.string().nullable(),
      ok: z.literal(true),
      rateLimited: z.boolean(),
      socials: z.array(ResolvedSocialSchema),
      socialsCount: z.number(),
      wikidataQid: z.string().nullable(),
    }),
  );

/**
 * `list_unresolved_artists` → `GET /admin/artists` (operationId `listUnresolvedArtists`).
 *
 * Agent tier (`adminAuth`). The artist-sweep worklist: a bounded, cursor-paged
 * page of artists still awaiting social resolution (`resolved_at IS NULL`),
 * oldest-first by id. The on-box `fluncle-artist-sweep` cron reads this to pick
 * the next batch, then calls `resolve_artist` per row. Returns `{ ok, artists:
 * [{ id, name }], nextCursor }` (`nextCursor` is null when the queue is drained).
 *
 * Named `list_unresolved_artists` (not `list_artists`) to avoid a Convention-B
 * collision with Unit 4's future public `api.artists` op.
 */
export const listUnresolvedArtists = oc
  .route({
    method: "GET",
    operationId: "listUnresolvedArtists",
    path: "/admin/artists",
    summary: "List artists awaiting social resolution, oldest first (the sweep worklist)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      cursor: z.string().optional(),
      limit: z.string().optional(),
    }),
  )
  .output(
    z.object({
      artists: z.array(z.object({ id: z.string(), name: z.string() })),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
    }),
  );

/** The `admin-artists` domain's ops, merged into the root contract by `./index.ts`. */
export const adminArtistsContract = {
  backfill_artists: backfillArtists,
  list_unresolved_artists: listUnresolvedArtists,
  resolve_artist: resolveArtist,
};
