// The `me-recs` domain contract module — the per-user recommendation engine's
// slice of the `/me` private-user tier (docs/the-ear.md § The per-user
// telescopes): the user's seed set (≤12 tracks their telescope points from) and
// the computed recommendations. The list/recommendations reads are cookie-session;
// save/delete also require the CSRF mutation token. A future wave adds an op here
// and one import line in `./index.ts`, touching no other domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * One recommendation seed as `listRecSeeds` returns it. `logId` is present only
 * when the seed is a certified finding — a catalogue seed carries none (the
 * unnamed tier stays unnamed on this wire too).
 */
export const RecSeedSchema = z
  .object({
    addedAt: z.string(),
    artists: z.array(z.string()),
    // The cover URL (best-source resolve) — the recognition cue the row leads with.
    imageUrl: z.string().optional(),
    logId: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "RecSeed" });

/**
 * A recommended FINDING — a labeled slot (the option-B blend). Certified, so the
 * row carries Fluncle's full voice: the Log ID always, the note when he wrote one
 * (the row's WHY).
 */
export const RecommendationFindingSchema = z
  .object({
    artists: z.array(z.string()),
    // The instrument readout (The Readout Rule): each present only when the row carries it.
    bpm: z.number().optional(),
    durationMs: z.number().optional(),
    imageUrl: z.string().optional(),
    key: z.string().optional(),
    logId: z.string(),
    note: z.string().optional(),
    similarity: z.number(),
    spotifyUri: z.string().optional(),
    spotifyUrl: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
    year: z.string().optional(),
  })
  .meta({ id: "RecommendationFinding" });

/**
 * A recommended CATALOGUE track — the instrument register. Identity, listen-out
 * links, and the honest similarity number; deliberately NO editorial field (no
 * note, no coordinate — the wire never invents testimony for a track Fluncle has
 * not certified).
 */
export const RecommendationCatalogueSchema = z
  .object({
    artists: z.array(z.string()),
    // The instrument readout (The Readout Rule): each present only when the row carries it.
    bpm: z.number().optional(),
    durationMs: z.number().optional(),
    imageUrl: z.string().optional(),
    key: z.string().optional(),
    similarity: z.number(),
    spotifyUri: z.string().optional(),
    spotifyUrl: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
    year: z.string().optional(),
  })
  .meta({ id: "RecommendationCatalogue" });

/**
 * The save request body. LOOSE + optional UNKNOWN, the `me-saved` discipline:
 * `saveRecSeed` resolves `trackId`/`logId` itself, emitting `invalid_request`/
 * `track_not_found`/`seed_limit`. A permissive contract keeps oRPC from
 * pre-rejecting so that logic stays authoritative.
 */
const SaveRecSeedBodySchema = z.looseObject({
  logId: z.unknown().optional(),
  trackId: z.unknown().optional(),
});

/**
 * `list_private_rec_seeds` → `GET /me/rec-seeds`
 * (operationId `listPrivateRecSeeds`).
 *
 * The signed-in user's recommendation seeds, newest first, hydrated with
 * title/artists/cover (the saved-findings join shape). A missing session is the
 * rails-encoded 401 (`auth_required`).
 */
export const listPrivateRecSeeds = oc
  .route({
    method: "GET",
    operationId: "listPrivateRecSeeds",
    path: "/me/rec-seeds",
    summary: "List the signed-in user's recommendation seeds",
    tags: ["Me"],
  })
  .output(z.object({ ok: z.literal(true), seeds: z.array(RecSeedSchema) }));

/**
 * `save_private_rec_seed` → `POST /me/rec-seeds`
 * (operationId `savePrivateRecSeed`).
 *
 * Add a seed (by trackId or Log ID — archive or catalogue). CSRF-guarded.
 * Re-adding refreshes `addedAt`; a NEW seed past the 12-seed cap is a 409
 * (`seed_limit`). Unknown track: `track_not_found`/404.
 */
export const savePrivateRecSeed = oc
  .route({
    method: "POST",
    operationId: "savePrivateRecSeed",
    path: "/me/rec-seeds",
    summary: "Add a recommendation seed for the signed-in user",
    tags: ["Me"],
  })
  .input(SaveRecSeedBodySchema)
  .output(
    z.object({
      ok: z.literal(true),
      seed: z.object({
        addedAt: z.string(),
        logId: z.string().optional(),
        trackId: z.string(),
      }),
    }),
  );

/**
 * `delete_private_rec_seed` → `DELETE /me/rec-seeds/{trackId}`
 * (operationId `deletePrivateRecSeed`).
 *
 * Remove a seed (the path param resolves by trackId OR Log ID). CSRF-guarded;
 * an unknown track is `track_not_found`/404, removing a non-seed is a no-op
 * `{ ok: true }` (the `unsave_private_finding` discipline).
 */
export const deletePrivateRecSeed = oc
  .route({
    method: "DELETE",
    operationId: "deletePrivateRecSeed",
    path: "/me/rec-seeds/{trackId}",
    summary: "Remove a recommendation seed for the signed-in user",
    tags: ["Me"],
  })
  .input(z.object({ trackId: z.string() }))
  .output(z.object({ ok: z.literal(true) }));

/**
 * `list_private_recommendations` → `GET /me/recommendations`
 * (operationId `listPrivateRecommendations`).
 *
 * THE ENGINE: the embedded, Spotify-anchored catalogue ranked against the user's
 * seed vectors by max-similarity + the diversity decay, plus the 2–3 findings
 * nearest the seed set as labeled slots (the option-B blend). Requires a session
 * AND a verified email — unverified is a 403 (`email_unverified`). Rate-limited
 * hourly per user (each request is a real vector scan). Computed per request;
 * seeds without a vector are skipped honestly and named in `seedsSkipped`.
 */
export const listPrivateRecommendations = oc
  .route({
    method: "GET",
    operationId: "listPrivateRecommendations",
    path: "/me/recommendations",
    summary: "List the signed-in user's recommendations from their seeds",
    tags: ["Me"],
  })
  .output(
    z.object({
      catalogue: z.array(RecommendationCatalogueSchema),
      findings: z.array(RecommendationFindingSchema),
      ok: z.literal(true),
      seedsSkipped: z.array(z.string()),
      seedsUsed: z.number(),
    }),
  );

/** The `me-recs` domain's ops, merged into the root contract by `./index.ts`. */
export const meRecsContract = {
  delete_private_rec_seed: deletePrivateRecSeed,
  list_private_rec_seeds: listPrivateRecSeeds,
  list_private_recommendations: listPrivateRecommendations,
  save_private_rec_seed: savePrivateRecSeed,
};
