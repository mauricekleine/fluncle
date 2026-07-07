// The `admin-artists` domain contract module — the artist-entity backfill
// (Unit 1 of the artist-relationship RFC). Follows the `admin-backfills` pattern:
// a bounded, cursor-resumable POST with query params (no request body).
//
//   - `backfill_artists` — agent tier (`adminAuth`): re-fetches `/tracks/{trackId}`
//     for existing findings that predate the artists/track_artists tables and upserts
//     the entity rows. Idempotent: findings that already have a track_artists row are
//     skipped. The CLI loops the cursor until null.
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

// ── Epic B: the championing motion (Unit 5) ──────────────────────────────────
// The `/admin/artists` follow queue + the auto-follow sweep. `artist_socials` is the
// identity-graph store; these ops read the follow queue, register/confirm socials,
// add/remove them inline, and drive the agent-tier Spotify/YouTube auto-follow.

/** One `artist_socials` row, in the shape the admin surfaces read. */
const ArtistSocialSchema = z
  .object({
    artistId: z.string(),
    followedAt: z.string().nullable(),
    id: z.string(),
    platform: z.string(),
    source: z.string(),
    status: z.string(),
    url: z.string(),
  })
  .meta({ id: "ArtistSocial" });

/** The `{ ok, social }` envelope every single-social operator write returns. */
const ArtistSocialEnvelope = z.object({ ok: z.literal(true), social: ArtistSocialSchema });

/** One artist in the follow queue, carrying all its socials. */
const ArtistFollowQueueItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    socials: z.array(ArtistSocialSchema),
    spotifyUrl: z.string().nullable(),
  })
  .meta({ id: "ArtistFollowQueueItem" });

/**
 * `list_artist_socials` → `GET /admin/artists/socials` (operationId `listArtistSocials`).
 *
 * Admin tier (agent-allowed read). The `/admin/artists` follow queue: every artist with
 * actionable work (a `candidate` to confirm, or a followable social not yet followed),
 * each carrying ALL its socials. Returns `{ ok, artists }`.
 */
export const listArtistSocials = oc
  .route({
    method: "GET",
    operationId: "listArtistSocials",
    path: "/admin/artists/socials",
    summary: "The artist follow queue (artists with unconfirmed/unfollowed socials)",
    tags: ["Admin"],
  })
  .input(z.object({ limit: z.string().optional() }))
  .output(z.object({ artists: z.array(ArtistFollowQueueItemSchema), ok: z.literal(true) }));

/**
 * `follow_artist` → `POST /admin/artists/follow` (operationId `followArtist`).
 *
 * Agent tier (`adminAuth`). The championing motion's automated half: follow a bounded
 * batch of high-confidence artists across Spotify + YouTube (`status IN (auto,
 * confirmed)`, idempotent by `followed_at IS NULL`, quota-paced). The on-box
 * `fluncle-artist-follow` sweep loops it via `remaining`. Bodyless POST with query
 * params (the `backfill_artists` shape). Returns `{ ok, dryRun, followed, followedCount,
 * failed, failedCount, remaining }`.
 */
export const followArtist = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "followArtist",
    path: "/admin/artists/follow",
    summary: "Auto-follow a batch of high-confidence artists (Spotify + YouTube)",
    tags: ["Admin"],
  })
  .input(
    z.object({ query: z.object({ dryRun: z.string().optional(), limit: z.string().optional() }) }),
  )
  .output(
    z.object({
      dryRun: z.boolean(),
      failed: z.array(z.object({ error: z.string(), platform: z.string(), socialId: z.string() })),
      failedCount: z.number(),
      followed: z.array(
        z.object({
          artistId: z.string(),
          artistName: z.string(),
          platform: z.string(),
          socialId: z.string(),
        }),
      ),
      followedCount: z.number(),
      ok: z.literal(true),
      remaining: z.number(),
    }),
  );

/**
 * `record_operator_follow` → `POST /admin/artists/socials/{socialId}/follow`
 * (operationId `recordOperatorFollow`). Operator tier. Register that the operator
 * manually followed a social (stamps `followed_at`). Idempotent. `{ ok, social }`.
 */
export const recordOperatorFollow = oc
  .route({
    method: "POST",
    operationId: "recordOperatorFollow",
    path: "/admin/artists/socials/{socialId}/follow",
    summary: "Register a manual follow of an artist social (stamp followed_at)",
    tags: ["Admin"],
  })
  .input(z.object({ socialId: z.string() }))
  .output(ArtistSocialEnvelope);

/**
 * `confirm_artist_social` → `POST /admin/artists/socials/{socialId}/confirm`
 * (operationId `confirmArtistSocial`). Operator tier. Promote a `candidate` social to
 * `confirmed` (the one-tap glance that lets it onto the public page). `{ ok, social }`.
 */
export const confirmArtistSocial = oc
  .route({
    method: "POST",
    operationId: "confirmArtistSocial",
    path: "/admin/artists/socials/{socialId}/confirm",
    summary: "Confirm a candidate artist social (candidate → confirmed)",
    tags: ["Admin"],
  })
  .input(z.object({ socialId: z.string() }))
  .output(ArtistSocialEnvelope);

/**
 * `add_artist_social` → `POST /admin/artists/{artistId}/socials` (operationId
 * `addArtistSocial`). Operator tier. Add/replace an artist's social by platform
 * (`source=operator`, `status=confirmed`). LOOSE body — the handler validates the
 * platform + URL. `{ ok, social }`.
 */
export const addArtistSocial = oc
  .route({
    method: "POST",
    operationId: "addArtistSocial",
    path: "/admin/artists/{artistId}/socials",
    summary: "Add or replace an artist's social link by platform",
    tags: ["Admin"],
  })
  .input(z.looseObject({ artistId: z.string() }))
  .output(ArtistSocialEnvelope);

/**
 * `remove_artist_social` → `DELETE /admin/artists/socials/{socialId}` (operationId
 * `removeArtistSocial`). Operator tier. Remove one artist social. Idempotent. `{ ok }`.
 */
export const removeArtistSocial = oc
  .route({
    method: "DELETE",
    operationId: "removeArtistSocial",
    path: "/admin/artists/socials/{socialId}",
    summary: "Remove an artist social link",
    tags: ["Admin"],
  })
  .input(z.object({ socialId: z.string() }))
  .output(z.object({ ok: z.literal(true) }));

/** The `admin-artists` domain's ops, merged into the root contract by `./index.ts`. */
export const adminArtistsContract = {
  add_artist_social: addArtistSocial,
  backfill_artists: backfillArtists,
  confirm_artist_social: confirmArtistSocial,
  follow_artist: followArtist,
  list_artist_socials: listArtistSocials,
  record_operator_follow: recordOperatorFollow,
  remove_artist_social: removeArtistSocial,
};
