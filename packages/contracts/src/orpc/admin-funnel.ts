// The `admin-funnel` domain contract module — the catalogue pipeline on one admin page
// (docs/rfcs/catalogue-funnel-rfc.md). Two ops, both under `/admin/funnel`, both admin tier:
//
//   - `record_catalogue_snapshot` — AGENT tier (`adminAuth`, NOT `operatorGuard`): the box's
//     `fluncle-funnel-snapshot` daily timer POSTs a bare trigger; the Worker computes every
//     stage total + queue depth + frontier count and UPSERTS one row per UTC day (idempotent
//     by day — a re-fired tick overwrites rather than doubles a bar). Internal write only (the
//     `catalogue_snapshots` ledger), fully reversible, so an operator token is not required —
//     the `record_health` / `record_platform_stats` precedent.
//   - `get_funnel` — admin tier: the live stages + queues + meters computed NOW, plus the
//     bounded day-by-day series read back from the ledger, in ONE call.
//
// The tier has no PUBLIC name (the catalogue is never introduced to the crew): this is an
// operator surface, so neither op is on the public OpenAPI document.

import { oc } from "@orpc/contract";
import * as z from "zod";

/** The funnel's stage totals — cumulative counts of rows that have reached each stage. */
const FunnelStagesSchema = z
  .object({
    analyzed: z.number().int(),
    anchored: z.number().int(),
    captured: z.number().int(),
    certified: z.number().int(),
    crawled: z.number().int(),
    embedded: z.number().int(),
    recEligible: z.number().int(),
  })
  .meta({ id: "FunnelStages" });

/** The funnel's queue depths — how much is waiting behind each stage. */
const FunnelQueuesSchema = z
  .object({
    analyzeQueue: z.number().int(),
    anchorBackoff: z.number().int(),
    anchorQueueIsrc: z.number().int(),
    anchorQueueNoIsrc: z.number().int(),
    captureQueue: z.number().int(),
    embedQueue: z.number().int(),
  })
  .meta({ id: "FunnelQueues" });

/**
 * The LIVE queue depths — the persisted queues plus the anchor worklist split by whether the row
 * already carries a MuQ embedding. `anchorQueueReady` is the embedded head the hourly anchor sweep
 * actually works (the actionable number); `anchorQueueAwaitingAudio` is crawler metadata still
 * waiting on capture/embed (it costs nothing until the audio pipeline reaches it). Both derive from
 * the SAME anchor worklist predicate, so they sum to `anchorQueueIsrc + anchorQueueNoIsrc`. This
 * split is a live-read refinement only — it is never persisted, so it rides `live.queues`, not the
 * snapshot row.
 */
const FunnelLiveQueuesSchema = FunnelQueuesSchema.extend({
  anchorQueueAwaitingAudio: z.number().int(),
  anchorQueueReady: z.number().int(),
}).meta({ id: "FunnelLiveQueues" });

/** The operator's spend levers, surfaced as gauges. */
const FunnelMetersSchema = z
  .object({
    anchorBackoff: z.number().int(),
    captureBudget: z.object({
      dailyBytes: z.number().int(),
      dailyTracks: z.number().int(),
      open: z.boolean(),
      paused: z.boolean(),
      remainingBytes: z.number().int(),
      remainingTracks: z.number().int(),
      windowHours: z.number().int(),
    }),
    frontierPending: z.number().int(),
  })
  .meta({ id: "FunnelMeters" });

/** One persisted snapshot row — the counts + its day + when it was written. */
const CatalogueSnapshotRowSchema = z
  .object({
    analyzeQueue: z.number().int(),
    analyzed: z.number().int(),
    anchorBackoff: z.number().int(),
    anchorQueueIsrc: z.number().int(),
    anchorQueueNoIsrc: z.number().int(),
    anchored: z.number().int(),
    captureQueue: z.number().int(),
    captured: z.number().int(),
    certified: z.number().int(),
    crawled: z.number().int(),
    createdAt: z.string(),
    day: z.string(),
    embedQueue: z.number().int(),
    embedded: z.number().int(),
    frontierDone: z.number().int(),
    frontierPending: z.number().int(),
    recEligible: z.number().int(),
  })
  .meta({ id: "CatalogueSnapshotRow" });

/**
 * `record_catalogue_snapshot` → `POST /admin/funnel/snapshot` (operationId
 * `recordCatalogueSnapshot`).
 *
 * AGENT tier (`adminAuth`, no `operatorGuard`): the box's daily funnel-snapshot cron drives
 * it with a bare trigger. Persists ONE idempotent snapshot for the UTC day (upsert on `day`),
 * and returns the row written.
 */
export const recordCatalogueSnapshot = oc
  .route({
    method: "POST",
    operationId: "recordCatalogueSnapshot",
    path: "/admin/funnel/snapshot",
    summary: "Record today's catalogue-funnel snapshot (idempotent per UTC day)",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(z.object({ ok: z.literal(true), snapshot: CatalogueSnapshotRowSchema }));

/**
 * `get_funnel` → `GET /admin/funnel` (operationId `getFunnel`).
 *
 * Admin tier. Returns the live pipeline (stages + queues + meters) computed on every load, plus the
 * bounded snapshot series (oldest-first, cut in SQL). The live block is a handful of sub-second COUNT
 * scans, so this single-operator admin surface computes it fresh rather than serving a stale daily
 * snapshot; only the growth `series` is read back from the `catalogue_snapshots` ledger. `windowDays`
 * is a tolerant optional STRING (the query-param convention — parsed + clamped in-handler, default 90,
 * max 365).
 */
export const getFunnel = oc
  .route({
    method: "GET",
    operationId: "getFunnel",
    path: "/admin/funnel",
    summary: "The catalogue funnel — live pipeline + the day-by-day growth series",
    tags: ["Admin"],
  })
  .input(z.object({ windowDays: z.string().optional() }))
  .output(
    z.object({
      live: z.object({
        meters: FunnelMetersSchema,
        queues: FunnelLiveQueuesSchema,
        stages: FunnelStagesSchema,
      }),
      series: z.array(CatalogueSnapshotRowSchema),
    }),
  );

/** The `admin-funnel` domain's ops, merged into the root contract by `./index.ts`. */
export const adminFunnelContract = {
  get_funnel: getFunnel,
  record_catalogue_snapshot: recordCatalogueSnapshot,
};
