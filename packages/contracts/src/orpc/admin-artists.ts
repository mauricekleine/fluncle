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

/** A failed artist-image row (`{ artistId, error }`). */
const ArtistImagesBackfillFailedSchema = z
  .object({
    artistId: z.string(),
    error: z.string(),
  })
  .meta({ id: "ArtistImagesBackfillFailed" });

/**
 * `backfill_artist_images` → `POST /admin/backfill/artist-images` (operationId
 * `backfillArtistImages`).
 *
 * Agent tier (`adminAuth`). One bounded, cursor-resumable pass over artists still
 * missing a Spotify avatar (`image_url IS NULL` and a Spotify id to look up). Each
 * pass batch-fetches the largest Spotify profile image (one `/v1/artists` call) and
 * stamps `artists.image_url`. Idempotent + self-draining (an imaged artist drops out
 * of the queue). Returns `{ ok, dryRun, filled, filledCount, skipped, skippedCount,
 * failed, failedCount, nextCursor }` — `skipped` = artists Spotify has no image for.
 */
export const backfillArtistImages = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillArtistImages",
    path: "/admin/backfill/artist-images",
    summary: "Back-fill artist Spotify avatars (image_url) for existing artists (batched)",
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
      failed: z.array(ArtistImagesBackfillFailedSchema),
      failedCount: z.number(),
      filled: z.array(z.string()),
      filledCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      skipped: z.array(z.string()),
      skippedCount: z.number(),
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
      "beatport",
      "facebook",
      "homepage",
      "instagram",
      "mixcloud",
      "soundcloud",
      "spotify",
      "tiktok",
      "twitch",
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
 * collision with the public `list_artists` op.
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

// ── The identity graph: artist_socials (Unit 5) ──────────────────────────────
// The `/admin/artists` review queue + the per-social operator writes. `artist_socials`
// is the identity-graph store; these ops read the queue and confirm / add / remove the
// links that feed the public artist page + `sameAs` JSON-LD.

/** One `artist_socials` row, in the shape the admin surfaces read. */
const ArtistSocialSchema = z
  .object({
    artistId: z.string(),
    createdAt: z.string(),
    id: z.string(),
    platform: z.string(),
    /** When the operator last acknowledged this link, or null when it's still fresh (unreviewed). */
    reviewedAt: z.string().nullable(),
    source: z.string(),
    status: z.string(),
    url: z.string(),
  })
  .meta({ id: "ArtistSocial" });

/** The `{ ok, social }` envelope every single-social operator write returns. */
const ArtistSocialEnvelope = z.object({ ok: z.literal(true), social: ArtistSocialSchema });

/** One artist in the review queue, carrying all its socials. */
const ArtistSocialsQueueItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    socials: z.array(ArtistSocialSchema),
    spotifyUrl: z.string().nullable(),
  })
  .meta({ id: "ArtistSocialsQueueItem" });

/**
 * `list_artist_socials` → `GET /admin/artists/socials` (operationId `listArtistSocials`).
 *
 * Admin tier (agent-allowed read). The `/admin/artists` review queue: every artist with
 * a `candidate` social to confirm, each carrying ALL its socials. Returns `{ ok, artists }`.
 *
 * `fresh=true` widens the queue to the board's fresh-links rule: every artist carrying an
 * UNREVIEWED link (`reviewed_at IS NULL`) — which includes fresh `auto` links on artists
 * with no candidate at all, invisible to the default candidate-only narrowing.
 */
export const listArtistSocials = oc
  .route({
    method: "GET",
    operationId: "listArtistSocials",
    path: "/admin/artists/socials",
    summary: "The artist review queue (artists with unconfirmed socials)",
    tags: ["Admin"],
  })
  .input(z.object({ fresh: z.string().optional(), limit: z.string().optional() }))
  .output(z.object({ artists: z.array(ArtistSocialsQueueItemSchema), ok: z.literal(true) }));

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
 * `review_artist_social` → `POST /admin/artists/socials/{socialId}/review` (operationId
 * `reviewArtistSocial`). Operator tier. Approve ONE fresh link in the board's fresh-links
 * section: stamp `reviewed_at = now` (it leaves the fresh-links queue) and promote a `candidate`
 * to `confirmed` (onto the public page). Idempotent. `{ ok, social }`.
 */
export const reviewArtistSocial = oc
  .route({
    method: "POST",
    operationId: "reviewArtistSocial",
    path: "/admin/artists/socials/{socialId}/review",
    summary: "Review one artist social (mark reviewed; candidate → confirmed)",
    tags: ["Admin"],
  })
  .input(z.object({ socialId: z.string() }))
  .output(ArtistSocialEnvelope);

/**
 * `review_artist` → `POST /admin/artists/{artistId}/review` (operationId `reviewArtist`).
 * Operator tier. Mark an artist's link list as reviewed — the "Looks good" acknowledgment.
 * Stamps `reviewed_at = now` (clears needs-a-look until a NEW link is discovered) and promotes
 * any surviving `candidate` links to `confirmed` (reviewing the list is the trust gate; a wrong
 * candidate is deleted in Manage links first). Idempotent. `{ ok, confirmed }` — how many
 * candidates were promoted.
 */
export const reviewArtist = oc
  .route({
    method: "POST",
    operationId: "reviewArtist",
    path: "/admin/artists/{artistId}/review",
    summary: "Mark an artist's link list as reviewed (Looks good)",
    tags: ["Admin"],
  })
  .input(z.object({ artistId: z.string() }))
  .output(z.object({ confirmed: z.number(), ok: z.literal(true) }));

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

/**
 * `update_artist_social` → `PATCH /admin/artists/socials/{socialId}` (operationId
 * `updateArtistSocial`). Operator tier. Correct a social's URL AND approve it in one act —
 * the board's fresh-links INLINE EDIT (fixing a resolver miss without leaving the row). LOOSE
 * body — the handler validates + normalizes the `url` against the row's platform through the
 * resolver's `classifyMbUrl` + `normalizeProfileUrl`, then stores it operator-owned + confirmed
 * + reviewed. `{ ok, social }`.
 */
export const updateArtistSocial = oc
  .route({
    method: "PATCH",
    operationId: "updateArtistSocial",
    path: "/admin/artists/socials/{socialId}",
    summary: "Correct + approve an artist social's URL inline (operator)",
    tags: ["Admin"],
  })
  .input(z.looseObject({ socialId: z.string() }))
  .output(ArtistSocialEnvelope);

// ── The voiced bio: the entity-bio engine (agent-tier author + its worklist) ──────────
// `describe_artist` is the entity sibling of `note_track`: the on-box sweep authors the
// artist's short Fluncle-voiced bio (grounded in Firecrawl facts + the tracks Fluncle has
// logged), and this step VOICE-GATES it and writes it FILL-EMPTY-ONLY — an operator bio is
// never clobbered. `list_artists_missing_bio` is its worklist. Both agent tier: the box's
// agent token drives them, the `note_track` / `list_unresolved_artists` precedent.

/**
 * The describe body (POST /admin/artists/{slug}/bio). LOOSE: the live route voice-gates
 * `bio` itself and length-bounds it, so the contract stays permissive. `promptVersion` is
 * the bio's provenance (0 = the registry's baked default, N = operator override N); the
 * sweep sends it, an operator-typed bio sends nothing (the column stays NULL). `dryRun`
 * runs the voice gate and stores nothing.
 */
const DescribeEntityBodySchema = z.looseObject({
  bio: z.unknown().optional(),
  dryRun: z.unknown().optional(),
  promptVersion: z.number().int().min(0).optional(),
});

/**
 * `describe_artist` → `POST /admin/artists/{slug}/bio` (operationId `describeArtist`).
 *
 * Agent tier (`adminAuth`), the `note_track` precedent: the on-box sweep has authored the
 * artist's bio in Fluncle's voice (grounded in the gathered facts + the tracks Fluncle has
 * logged); this VOICE-GATES it (the banned-word / earthly-geography / exclamation /
 * "we"-as-company scan shared with the note gate, plus the bio's own length ceiling) and
 * stores it into the `bio` field with its `bio_prompt_version` provenance + `bio_status =
 * 'resolved'`, all atomically.
 *
 * SAFETY (the cardinal guarantee): it fills an EMPTY bio ONLY. An artist that already
 * carries a bio — operator-written OR previously auto-authored — is a no-op (`skipped:
 * true`); the agent NEVER clobbers an existing bio. `dryRun` runs the gate and stores
 * nothing. Codes: `not_found`/404, `no_bio`/400, `bio_too_short`/422, `bio_too_long`/422,
 * `voice_gate`/422.
 */
export const describeArtist = oc
  .route({
    method: "POST",
    operationId: "describeArtist",
    path: "/admin/artists/{slug}/bio",
    summary: "Auto-author an artist's voiced bio (fills an empty bio only)",
    tags: ["Admin"],
  })
  .input(DescribeEntityBodySchema.extend({ slug: z.string() }))
  .output(
    z.object({
      bio: z.string(),
      // `true` when `dryRun` was set: the voice gate ran, NOTHING was stored.
      dryRun: z.literal(true).optional(),
      ok: z.literal(true),
      // `true` when a bio already existed and the fill-empty-only guard refused to
      // clobber it; absent on a fresh fill.
      skipped: z.boolean().optional(),
      slug: z.string(),
    }),
  );

/**
 * `draft_artist_bio` → `GET /admin/artists/{slug}/bio-draft` (operationId `draftArtistBio`).
 *
 * Agent tier (`adminAuth`), the `describe_artist` sibling: the Worker-paced grounding seam.
 * The box holds no Firecrawl key and cannot enumerate an artist's finding TITLES; this READ
 * runs the Firecrawl gather (with the Worker's key) + pulls the logged finding titles (with
 * the Worker's DB) and assembles the registered bio prompt, handing the box a ready-to-author
 * PROMPT. The box then runs `claude -p` on it and writes back via `describe_artist`. A pure
 * read — it publishes nothing, and it returns only public facts (web snippets + finding
 * titles), never a secret or an internal id beyond the slug/name/count.
 *
 * `found:false` when the slug does not resolve (it never throws on a missing entity).
 * `hasFacts` reports whether Firecrawl returned any facts (false = the prompt's no-facts arm).
 */
export const draftArtistBio = oc
  .route({
    method: "GET",
    operationId: "draftArtistBio",
    path: "/admin/artists/{slug}/bio-draft",
    summary: "Assemble a ready-to-author bio prompt for an artist (Worker-side grounding)",
    tags: ["Admin"],
  })
  .input(z.object({ slug: z.string() }))
  .output(
    z.object({
      findingCount: z.number(),
      found: z.boolean(),
      hasFacts: z.boolean(),
      name: z.string(),
      prompt: z.string(),
      promptVersion: z.number(),
    }),
  );

/** One row of the bio worklist: an artist with findings but no bio yet. */
const ArtistBioWorkItemSchema = z
  .object({ id: z.string(), name: z.string(), slug: z.string() })
  .meta({ id: "ArtistBioWorkItem" });

/**
 * `list_artists_missing_bio` → `GET /admin/artists/bio-queue` (operationId
 * `listArtistsMissingBio`).
 *
 * Agent tier (`adminAuth`), the `list_unresolved_artists` precedent. The bio worklist:
 * artists with at least one coordinate-bearing finding but no bio yet, oldest-first — the
 * worklist the future `describe_artist` cron drains. A pure read; it publishes nothing.
 */
export const listArtistsMissingBio = oc
  .route({
    method: "GET",
    operationId: "listArtistsMissingBio",
    path: "/admin/artists/bio-queue",
    summary: "List artists with findings but no bio yet, oldest first (the bio worklist)",
    tags: ["Admin"],
  })
  .input(z.object({ limit: z.string().optional() }))
  .output(z.object({ artists: z.array(ArtistBioWorkItemSchema), ok: z.literal(true) }));

/** The `admin-artists` domain's ops, merged into the root contract by `./index.ts`. */
export const adminArtistsContract = {
  add_artist_social: addArtistSocial,
  backfill_artist_images: backfillArtistImages,
  backfill_artists: backfillArtists,
  confirm_artist_social: confirmArtistSocial,
  describe_artist: describeArtist,
  draft_artist_bio: draftArtistBio,
  list_artist_socials: listArtistSocials,
  list_artists_missing_bio: listArtistsMissingBio,
  list_unresolved_artists: listUnresolvedArtists,
  remove_artist_social: removeArtistSocial,
  resolve_artist: resolveArtist,
  review_artist: reviewArtist,
  review_artist_social: reviewArtistSocial,
  update_artist_social: updateArtistSocial,
};
