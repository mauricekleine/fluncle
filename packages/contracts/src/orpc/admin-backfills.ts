// The `admin-backfills` domain contract module — the operator-gated maintenance
// sweeps (the Discogs + Last.fm back-fills). Part of the admin fan-out, built on
// the same pattern as `./admin-tracks.ts`.
//
//   - `backfill_discogs` / `backfill_lastfm` — operator tier (live
//     `requireOperator`). Batched: one request handles a bounded pass and returns
//     `nextCursor`; the CLI loops `?cursor=` until null.
//
// The inputs are the live QUERY params (`limit`/`dryRun`/`cursor`), kept as
// tolerant optional strings: the live routes parse + clamp them in-handler and
// never 400 on a malformed value, so the contract must not coerce (coercion would
// reject `?limit=abc`). The handler reproduces the exact parse logic.
//
// These are query-only POSTs (the live routes carry their params on the URL, with
// NO request body). oRPC's compact input mode sources a POST's input from the
// BODY, so it would drop the query string; `inputStructure: "detailed"` makes the
// `query` explicit, so the params reach the handler and a bodyless POST is valid.
// The OUTPUT stays compact (the body is the envelope directly).

import { oc } from "@orpc/contract";
import * as z from "zod";

// The row shapes are ported VERBATIM from the live `backfill.ts` result types so
// the success bodies stay byte-for-byte for the CLI's `fluncle admin backfill`.

/** A resolved-Discogs row (`{ logId, releaseId, masterId?, source }`). */
const DiscogsResolvedSchema = z
  .object({
    logId: z.string(),
    masterId: z.number().optional(),
    releaseId: z.number(),
    source: z.string(),
  })
  .meta({ id: "DiscogsBackfillResolved" });

/** A failed-Last.fm row (`{ error, logId }`). */
const LastfmFailedSchema = z
  .object({
    error: z.string(),
    logId: z.string(),
  })
  .meta({ id: "LastfmBackfillFailed" });

/** A resolved-Apple-Music row (`{ logId, url }`). */
const AppleMusicResolvedSchema = z
  .object({
    logId: z.string(),
    url: z.string(),
  })
  .meta({ id: "AppleMusicBackfillResolved" });

/** A failed-Apple-Music row (`{ error, logId }`). */
const AppleMusicFailedSchema = z
  .object({
    error: z.string(),
    logId: z.string(),
  })
  .meta({ id: "AppleMusicBackfillFailed" });

/**
 * `backfill_discogs` → `POST /admin/backfill/discogs` (operationId
 * `backfillDiscogs`).
 *
 * Agent tier (`adminAuth`). One bounded, reliability-gated pass over
 * published findings missing a Discogs release id; on a confident match the ids are
 * written server-side. Returns `{ ok, dryRun, resolved, resolvedCount, unresolved,
 * unresolvedCount, skipped, skippedCount, nextCursor }` — `skipped` is the findings
 * the per-finding cooldown/done gate held back this pass.
 */
export const backfillDiscogs = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillDiscogs",
    path: "/admin/backfill/discogs",
    summary: "Back-fill Discogs release ids over published findings (batched)",
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
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      // True when the pass STOPPED on the Discogs rate-limit circuit breaker — the
      // CLI stops looping the cursor and the next tick resumes with a fresh window.
      rateLimited: z.boolean(),
      resolved: z.array(DiscogsResolvedSchema),
      resolvedCount: z.number(),
      // Findings the reliability gate skipped this pass (already resolved, or
      // cooling down after a recent attempt/failure) — they didn't burn the batch.
      skipped: z.array(z.string()),
      skippedCount: z.number(),
      unresolved: z.array(z.string()),
      unresolvedCount: z.number(),
    }),
  );

/**
 * `backfill_lastfm` → `POST /admin/backfill/lastfm` (operationId
 * `backfillLastfm`).
 *
 * Agent tier (`adminAuth`). One bounded, reliability-gated pass
 * loving published findings on Last.fm (idempotent). Returns `{ ok, dryRun, loved,
 * lovedCount, failed, failedCount, skipped, skippedCount, nextCursor }` — `skipped`
 * is the findings the per-finding cooldown/done gate held back this pass.
 */
export const backfillLastfm = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillLastfm",
    path: "/admin/backfill/lastfm",
    summary: "Back-fill Last.fm loves over published findings (batched)",
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
      failed: z.array(LastfmFailedSchema),
      failedCount: z.number(),
      loved: z.array(z.string()),
      lovedCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      // True when the pass STOPPED on the Last.fm rate-limit circuit breaker — the
      // CLI stops looping the cursor and the next tick resumes with a fresh window.
      rateLimited: z.boolean(),
      // Findings the reliability gate skipped this pass (already loved, or cooling
      // down after a recent attempt/failure) — they didn't burn the batch budget.
      skipped: z.array(z.string()),
      skippedCount: z.number(),
    }),
  );

/**
 * `backfill_apple_music` → `POST /admin/backfill/apple-music` (operationId
 * `backfillAppleMusic`).
 *
 * Agent tier (`adminAuth`). One bounded, reliability-gated pass over published findings
 * that carry an ISRC but no Apple Music URL; on an EXACT ISRC match (via the Apple Music
 * API) the URL is written server-side. NO-OP until the MusicKit secrets are provisioned
 * (`configured: false`). Returns `{ ok, configured, dryRun, resolved, resolvedCount,
 * unresolved, unresolvedCount, failed, failedCount, skipped, skippedCount, nextCursor,
 * rateLimited }` — `unresolved` is the ISRCs Apple had no song for, `skipped` the
 * findings the per-finding cooldown/done gate held back this pass.
 */
export const backfillAppleMusic = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillAppleMusic",
    path: "/admin/backfill/apple-music",
    summary: "Back-fill Apple Music URLs over published findings by exact ISRC (batched)",
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
      // Album-fact rows written once this pass (recordLabel/upc/artwork/palette) off the
      // single-ISRC oracle's canonical album — the second half of the Apple read (RFC U1).
      albumFactsWritten: z.number(),
      // True when the pass STOPPED because the cross-cutting Apple breaker is tripped (K
      // consecutive 401/403 — a suspended developer token) or its call budget is spent.
      breakerTripped: z.boolean(),
      // False when the MusicKit secrets are unset — the leg is a no-op this tick.
      configured: z.boolean(),
      dryRun: z.boolean(),
      failed: z.array(AppleMusicFailedSchema),
      failedCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      // True when the pass STOPPED on the Apple Music rate-limit circuit breaker — the
      // CLI stops looping the cursor and the next tick resumes with a fresh window.
      rateLimited: z.boolean(),
      resolved: z.array(AppleMusicResolvedSchema),
      resolvedCount: z.number(),
      // Findings the reliability gate skipped this pass (already resolved, or cooling
      // down after a recent attempt/failure) — they didn't burn the batch.
      skipped: z.array(z.string()),
      skippedCount: z.number(),
      // Findings whose ISRC Apple has no song for (a clean no-match, re-checkable later).
      unresolved: z.array(z.string()),
      unresolvedCount: z.number(),
    }),
  );

/** A resolved catalogue row (`{ trackId, url }`) — the batched drain keys by track, not log id. */
const AppleCatalogueResolvedSchema = z
  .object({
    trackId: z.string(),
    url: z.string(),
  })
  .meta({ id: "AppleCatalogueResolved" });

/** A failed catalogue row (`{ error, trackId }`). */
const AppleCatalogueFailedSchema = z
  .object({
    error: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "AppleCatalogueFailed" });

/**
 * `backfill_apple_catalogue` → `POST /admin/backfill/apple-catalogue` (operationId
 * `backfillAppleCatalogue`).
 *
 * Agent tier (`adminAuth`) — the catalogue sibling of `backfill_apple_music` (RFC U1). One
 * bounded, reliability-gated pass over CATALOGUE tracks (a `tracks` row with no `findings` row)
 * that carry an ISRC but no Apple URL: the BATCHED oracle (≤25 ISRCs/request) resolves the URL,
 * and the single-ISRC oracle populates each NEW album's second-authority facts once. No cursor —
 * the worklist is a fresh reliability-gated anti-join each tick, so a drained row simply drops
 * out. NO-OP until the MusicKit secrets are provisioned (`configured: false`). It writes catalogue
 * identity only (a URL on `tracks`, facts on `albums`) — never a certification — so it stays
 * agent-allowed, exactly like `rank_catalogue`.
 */
export const backfillAppleCatalogue = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillAppleCatalogue",
    path: "/admin/backfill/apple-catalogue",
    summary: "Back-fill Apple URLs + album facts over catalogue tracks by exact ISRC (batched)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      // Album-fact rows written once this pass (recordLabel/upc/artwork/palette).
      albumFactsWritten: z.number(),
      // True when the pass STOPPED on the cross-cutting Apple breaker (suspended token / spent
      // call budget) rather than a 429.
      breakerTripped: z.boolean(),
      configured: z.boolean(),
      dryRun: z.boolean(),
      failed: z.array(AppleCatalogueFailedSchema),
      failedCount: z.number(),
      ok: z.literal(true),
      rateLimited: z.boolean(),
      resolved: z.array(AppleCatalogueResolvedSchema),
      resolvedCount: z.number(),
      // Catalogue ISRCs Apple has no song for (a clean no-match, re-checkable later).
      unresolved: z.array(z.string()),
      unresolvedCount: z.number(),
    }),
  );

/** A failed label-image row (`{ error, slug }`). */
const LabelImagesBackfillFailedSchema = z
  .object({
    error: z.string(),
    slug: z.string(),
  })
  .meta({ id: "LabelImagesBackfillFailed" });

/**
 * `backfill_label_images` → `POST /admin/backfill/label-images` (operationId
 * `backfillLabelImages`).
 *
 * Agent tier (`adminAuth`): internal + reversible metadata enrichment (it resolves a label's
 * OWN logo and stores it in R2 — no publish), so the box's agent-token cron drives it. One
 * bounded, reliability-gated pass over the `labels` worklist: each label's identity is walked
 * (MusicBrainz label search → its curated Discogs/Wikidata url-rels) and its logo downloaded once
 * into our own bucket, up the ladder Discogs → Wikidata → none (the freshest-cover floor).
 * Returns `{ ok, dryRun, resolved, resolvedCount, none, noneCount, failed, failedCount,
 * nextCursor, rateLimited }` — `none` is the labels with no own image anywhere (floored to the
 * cover), `rateLimited` STOPS the loop on a vendor throttle.
 */
export const backfillLabelImages = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillLabelImages",
    path: "/admin/backfill/label-images",
    summary: "Resolve label logos (Discogs → Wikidata) into R2 for existing labels (batched)",
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
      failed: z.array(LabelImagesBackfillFailedSchema),
      failedCount: z.number(),
      nextCursor: z.string().nullable(),
      // Labels with no own image anywhere (Discogs + Wikidata both empty) — floored to the
      // freshest finding's cover, terminal so they never re-resolve.
      none: z.array(z.string()),
      noneCount: z.number(),
      ok: z.literal(true),
      // True when the pass STOPPED on a vendor rate-limit circuit breaker — the CLI stops
      // looping the cursor and the next tick resumes with a fresh window.
      rateLimited: z.boolean(),
      resolved: z.array(z.string()),
      resolvedCount: z.number(),
    }),
  );

/** The `admin-backfills` domain's ops, merged into the root contract by `./index.ts`. */
export const adminBackfillsContract = {
  backfill_apple_catalogue: backfillAppleCatalogue,
  backfill_apple_music: backfillAppleMusic,
  backfill_discogs: backfillDiscogs,
  backfill_label_images: backfillLabelImages,
  backfill_lastfm: backfillLastfm,
};
