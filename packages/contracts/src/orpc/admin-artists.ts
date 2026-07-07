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

/**
 * The follow/undo envelope: the row plus a soft `platformWarning`. The platform write
 * (Spotify/YouTube) is best-effort — a miss (e.g. our Development-mode app's artist-follow
 * 403) still records the follow-state and returns a human warning line here instead of
 * failing the request; `null` when the write went through (or the platform has no follow API).
 */
const ArtistFollowEnvelope = ArtistSocialEnvelope.extend({
  platformWarning: z.string().nullable(),
});

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
 * batch of high-confidence artists on YouTube (`status IN (auto, confirmed)`, idempotent
 * by `followed_at IS NULL`, quota-paced). Spotify is excluded — its artist-follow endpoint
 * is dev-mode-gated for our app, so Spotify championing runs through the manual
 * /admin/artists queue (see docs/ROADMAP.md). The on-box `fluncle-artist-follow` sweep
 * loops it via `remaining`. Bodyless POST with query params (the `backfill_artists`
 * shape). Returns `{ ok, dryRun, followed, followedCount, failed, failedCount, remaining }`.
 */
export const followArtist = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "followArtist",
    path: "/admin/artists/follow",
    summary: "Auto-follow a batch of high-confidence artists on YouTube",
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
 * `follow_artist_social` → `POST /admin/artists/socials/{socialId}/follow-now`
 * (operationId `followArtistSocial`). Operator tier. Perform the REAL platform follow for one
 * Spotify/YouTube social on demand (PUT /me/following, subscriptions.insert), then stamp
 * `followed_at`. Idempotent. A no-API platform is rejected (400) — use `record_operator_follow`
 * there. The platform write is best-effort: a miss (e.g. our Development-mode app's 403) still
 * records the follow and returns a soft `platformWarning`. `{ ok, social, platformWarning }`.
 */
export const followArtistSocial = oc
  .route({
    method: "POST",
    operationId: "followArtistSocial",
    path: "/admin/artists/socials/{socialId}/follow-now",
    summary: "Follow a Spotify/YouTube artist social now via the platform API",
    tags: ["Admin"],
  })
  .input(z.object({ socialId: z.string() }))
  .output(ArtistFollowEnvelope);

/**
 * `unfollow_artist_social` → `POST /admin/artists/socials/{socialId}/unfollow`
 * (operationId `unfollowArtistSocial`). Operator tier. Undo a followed social: a Spotify/YouTube
 * row is REALLY unfollowed via the API (DELETE /me/following, subscriptions.delete); a no-API
 * platform just clears `followed_at`. The platform write is best-effort: a miss still clears the
 * stamp and returns a soft `platformWarning`. Idempotent. `{ ok, social, platformWarning }`.
 */
export const unfollowArtistSocial = oc
  .route({
    method: "POST",
    operationId: "unfollowArtistSocial",
    path: "/admin/artists/socials/{socialId}/unfollow",
    summary: "Undo a followed artist social (real API unfollow for Spotify/YouTube)",
    tags: ["Admin"],
  })
  .input(z.object({ socialId: z.string() }))
  .output(ArtistFollowEnvelope);

/**
 * `unmute_artist_social` → `POST /admin/artists/socials/{socialId}/unmute`
 * (operationId `unmuteArtistSocial`). Operator tier. Clear a social's mute (`muted_at`),
 * reversing an Undo's durable skip so the sweep may champion it again. Idempotent. No platform
 * call. `{ ok, social }`.
 */
export const unmuteArtistSocial = oc
  .route({
    method: "POST",
    operationId: "unmuteArtistSocial",
    path: "/admin/artists/socials/{socialId}/unmute",
    summary: "Unmute an artist social (clear the don't-champion skip)",
    tags: ["Admin"],
  })
  .input(z.object({ socialId: z.string() }))
  .output(ArtistSocialEnvelope);

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
  follow_artist_social: followArtistSocial,
  list_artist_socials: listArtistSocials,
  list_unresolved_artists: listUnresolvedArtists,
  record_operator_follow: recordOperatorFollow,
  remove_artist_social: removeArtistSocial,
  resolve_artist: resolveArtist,
  unfollow_artist_social: unfollowArtistSocial,
  unmute_artist_social: unmuteArtistSocial,
};
