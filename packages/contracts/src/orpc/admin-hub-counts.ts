// The `admin-hub-counts` domain contract module — the SELF-HEALING BACKSTOP under the
// maintained hub counts (docs/db-scale-backlog Wave 2 keystone 2, slice C). A contract-only
// oRPC domain (no TanStack route files; oRPC owns the path directly), built on the
// `admin-funnel` pattern.
//
// WHY A RECONCILIATION SWEEP EXISTS AT ALL. `labels`, `albums` and `artists` each carry
// `renderable_track_count` + `certified_finding_count`, maintained as DELTAS by every
// edge-writing path (lib/server/hub-counts.ts) because recompute-from-truth measured
// 27,400 ms at 150k hosted against ~200 ms for the delta form. A maintained counter's
// failure mode is SILENT, and it drifts for reasons the write side cannot fix from inside:
// a missed write path, a non-atomic bulk op, or an out-of-band write (the operator's
// catalogue-prune skill deletes tracks straight out of the database; no server path does).
// This op is the reconcile that repairs that drift.
//
// VERIFIED auth tier (enforced in the handler, not the contract):
//   - `reconcile_hub_counts` — AGENT tier (`adminAuth` only, no `operatorGuard`): the
//     `rank_catalogue` / `record_catalogue_snapshot` precedent. It rewrites only DERIVED
//     bookkeeping integers on entity rows — it cannot mint a coordinate, write a note, or
//     certify anything — so the box's nightly `fluncle-reconcile-hub-counts` cron drives it
//     with the agent-scoped token it already holds.
//
// A NON-ZERO `corrected` IS A SIGNAL, NOT NOISE. It means a write path is leaking, so the
// numbers must SURFACE rather than vanish: the sweep logs them, and journalctl on the box is
// the operator's drift audit.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * One table's reconciliation outcome for the pages the call processed. An OBJECT rather than a
 * bare number so the shape has room to grow without a breaking change.
 */
const HubCountsTableResultSchema = z
  .object({
    /**
     * Entity rows whose stored counters DISAGREED with truth and were rewritten.
     * Zero is the healthy steady state; non-zero means a write path leaked and is the drift
     * signal worth reading.
     */
    corrected: z.number(),
    /**
     * Drifted rows left for the next pass because a maintained counter delta moved them between
     * the page read and the guarded write, twice. The concurrent delta is kept, never overwritten.
     */
    deferred: z.number(),
  })
  .meta({ id: "HubCountsTableResult" });

/** Where a windowed reconciliation resumes. */
const HubCountsReconcileCursorSchema = z
  .object({
    /** The last entity id already reconciled in `table`; null starts the table at its first id. */
    afterId: z.string().min(1).max(512).nullable(),
    /** The entity table, walked in `labels → albums → artists` order. */
    table: z.enum(["labels", "albums", "artists"]),
  })
  .meta({ id: "HubCountsReconcileCursor" });

/**
 * `reconcile_hub_counts` → `POST /admin/hub-counts/reconcile` (operationId
 * `reconcileHubCounts`).
 *
 * AGENT tier (`adminAuth` only). The WORKER does all the work in SQL.
 *
 * THE SHAPE. Per entity table, in `id` order, one read statement takes a bounded keyset page of
 * entity rows and joins each to its own tracks by the entity's index, returning the stored
 * counters beside the truth from one snapshot. Only rows that disagree are written, each as a
 * primary-key compare-and-set on the counters the page read, with its due-work marker, in a write
 * batch of point writes. No write transaction ever aggregates the track graph, and a maintained
 * delta that lands between the read and the write is kept (the page is re-read once; a row that
 * loses again is `deferred`).
 *
 * THE ARTISTS SOURCE IS PINNED to edges whose track exists (`track_artists` joined to `tracks`),
 * never raw `track_artists`: production carries ORPHANED edges from out-of-band track deletion,
 * and the hub reads join `tracks`. Counting raw edges would "correct" the counters into
 * disagreeing with what actually renders.
 *
 * WINDOWS. With `pageLimit` (and, after the first window, the previous response's `next` as
 * `cursor`) the call processes at most that many pages and returns `next`, null once every table
 * is done; the nightly box sweep runs one such window per admitted database phase. An empty body
 * runs every page in one request.
 */
export const reconcileHubCounts = oc
  .route({
    method: "POST",
    operationId: "reconcileHubCounts",
    path: "/admin/hub-counts/reconcile",
    summary: "Reconcile the maintained hub counts against truth and report the corrected rows",
    tags: ["Admin"],
  })
  .input(
    z.object({
      /** Resume point from the previous window's `next`; absent starts at the first label. */
      cursor: HubCountsReconcileCursorSchema.optional(),
      /** Keyset pages to process in this call; absent with no cursor runs every page. */
      pageLimit: z.number().int().min(1).max(20).optional(),
    }),
  )
  .output(
    z.object({
      albums: HubCountsTableResultSchema,
      artists: HubCountsTableResultSchema,
      labels: HubCountsTableResultSchema,
      /** The cursor to resume from, or null once every table has been reconciled. */
      next: HubCountsReconcileCursorSchema.nullable(),
      ok: z.literal(true),
      /** Keyset pages this call processed. */
      pages: z.number(),
      /** Wall-clock milliseconds the call took, server-side. */
      tookMs: z.number(),
    }),
  );

/** The `admin-hub-counts` domain's ops, merged into the root contract by `./index.ts`. */
export const adminHubCountsContract = {
  reconcile_hub_counts: reconcileHubCounts,
};
