// The `admin-backfills` domain contract module — the operator-gated maintenance
// sweeps (the Discogs + Last.fm back-fills). Part of the admin fan-out
// (docs/orpc-migration-brief.md), built on the same pattern as `./admin-tracks.ts`.
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
      // Findings the reliability gate skipped this pass (already loved, or cooling
      // down after a recent attempt/failure) — they didn't burn the batch budget.
      skipped: z.array(z.string()),
      skippedCount: z.number(),
    }),
  );

/** A failed-alignment row (`{ error, logId }`). */
const AlignmentFailedSchema = z
  .object({
    error: z.string(),
    logId: z.string(),
  })
  .meta({ id: "AlignmentBackfillFailed" });

/**
 * `backfill_alignment` → `POST /admin/backfill/alignment` (operationId
 * `backfillAlignment`).
 *
 * Agent tier (`adminAuth`): a reversible, no-publish re-derivation of word-level
 * caption timings over observations rendered before `/with-timestamps` (audio +
 * script on R2, no alignment). One bounded pass force-aligns each eligible finding's
 * existing mp3 to its script (no re-render) and writes the word timings. Returns
 * `{ ok, dryRun, aligned, alignedCount, empty, emptyCount, failed, failedCount,
 * nextCursor }` — `empty` is the findings the aligner returned no usable words for
 * (stored as a sentinel so they aren't re-burned).
 */
export const backfillAlignment = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillAlignment",
    path: "/admin/backfill/alignment",
    summary: "Back-fill word-level observation caption timings (forced-alignment, batched)",
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
      aligned: z.array(z.string()),
      alignedCount: z.number(),
      dryRun: z.boolean(),
      empty: z.array(z.string()),
      emptyCount: z.number(),
      failed: z.array(AlignmentFailedSchema),
      failedCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
    }),
  );

/** The `admin-backfills` domain's ops, merged into the root contract by `./index.ts`. */
export const adminBackfillsContract = {
  backfill_alignment: backfillAlignment,
  backfill_discogs: backfillDiscogs,
  backfill_lastfm: backfillLastfm,
};
