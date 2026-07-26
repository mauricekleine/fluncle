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
// SLICE A'S OWN ROLLOUT PROVED IT on day one — the deploy-window skew between the backfill
// and the first delta-maintained writes left 44 artists, 3 albums and 1 label off until a
// manual reconcile. That reconcile is this op.
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
 * One table's reconciliation outcome. An OBJECT rather than a bare number so the shape has
 * room to grow (a per-table `tookMs`, a sample of corrected ids) without a breaking change.
 */
const HubCountsTableResultSchema = z
  .object({
    /**
     * Entity rows whose stored counters DISAGREED with truth and were rewritten this pass.
     * Zero is the healthy steady state; non-zero means a write path leaked and is the drift
     * signal worth reading.
     */
    corrected: z.number(),
  })
  .meta({ id: "HubCountsTableResult" });

/**
 * `reconcile_hub_counts` → `POST /admin/hub-counts/reconcile` (operationId
 * `reconcileHubCounts`).
 *
 * AGENT tier (`adminAuth` only) — a bare trigger, the `record_catalogue_snapshot` shape: the
 * box POSTs an empty body and the WORKER does all the work in SQL.
 *
 * THE SHAPE. Per table, two statements, and never a row-by-row loop:
 *
 *   1. The GROUPED CORRECTION — `UPDATE <entity> … FROM (SELECT <fk>, count(*), sum(is_catalogue = 0)
 *      … GROUP BY <fk>) src WHERE <entity>.id = src.<fk> AND (counts differ)`. The
 *      counts-differ guard is what makes `rowsAffected` mean "rows CORRECTED" rather than
 *      "rows re-written", so the number reported is the drift, exactly.
 *   2. The ZERO-TRUTH pass — an entity whose last track was deleted out of band keeps a stale
 *      NON-ZERO count and appears in NO group, so statement 1 can never reach it. A second
 *      small `UPDATE … SET both = 0 WHERE counts <> 0 AND id NOT IN (<the grouped source's
 *      keys>)` closes it. Its `rowsAffected` folds into the same per-table `corrected`.
 *
 * THE ARTISTS SOURCE IS PINNED to `track_artists ta JOIN tracks t ON t.track_id = ta.track_id`,
 * never raw `track_artists`: production carries ORPHANED edges (62 of them, from out-of-band
 * track deletion), and the hub reads join `tracks`. Counting raw edges would "correct" the
 * counters into disagreeing with what actually renders — a fix that breaks the page. Labels and
 * albums group over `tracks` directly (`WHERE label_id / album_id IS NOT NULL` — load-bearing:
 * a NULL inside the zero-truth `NOT IN` subselect would make the whole predicate NULL and match
 * nothing).
 *
 * Runs off-peak nightly. The whole recompute pass measured 19.3 s at 150k hosted as three
 * correlated statements; the grouped `UPDATE … FROM` shape is cheaper, and anything under ~30 s
 * is fine at this cadence.
 */
export const reconcileHubCounts = oc
  .route({
    method: "POST",
    operationId: "reconcileHubCounts",
    path: "/admin/hub-counts/reconcile",
    summary: "Reconcile the maintained hub counts against truth and report the corrected rows",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(
    z.object({
      albums: HubCountsTableResultSchema,
      artists: HubCountsTableResultSchema,
      labels: HubCountsTableResultSchema,
      ok: z.literal(true),
      /** Wall-clock milliseconds the whole reconciliation took, server-side. */
      tookMs: z.number(),
    }),
  );

/** The `admin-hub-counts` domain's ops, merged into the root contract by `./index.ts`. */
export const adminHubCountsContract = {
  reconcile_hub_counts: reconcileHubCounts,
};
