// The `admin-reach` domain contract module — the agent-tier WRITE that feeds the
// public /reach page. A NOUN-SWAP of `record_health`: a daily on-box trigger POSTs
// here, the Worker fetches every Tier-1 platform with the auth it already holds, and
// one append-only `platform_stats` snapshot row lands per (platform, metric).
//
//   - `record_platform_stats` — AGENT tier (`adminAuth`, NOT `operatorGuard`): the
//     box's agent token drives the cron, exactly like `record_health`/`record_cost`.
//     It writes only the internal `platform_stats` table (no publish, fully
//     reversible), so an operator token is not required.
//
// The op takes NO body — the Worker owns every platform credential, so the box is a
// bare trigger (zero LLM tokens, the crawl/rank precedent). The output is the
// per-platform outcome: which platforms landed (and their metric names), which were
// skipped (with a reason), and how many rows were actually written (a same-day
// re-run lands `inserted: 0`, since the snapshot is idempotent by id).

import { oc } from "@orpc/contract";
import * as z from "zod";

/** A platform whose numbers landed this collect (the metric names written). */
const CollectedPlatformSchema = z
  .object({
    metrics: z.array(z.string()),
    platform: z.string(),
  })
  .meta({ id: "ReachCollectedPlatform" });

/** A platform skipped this collect (unconfigured, or a best-effort fetch fault). */
const SkippedPlatformSchema = z
  .object({
    platform: z.string(),
    reason: z.string(),
  })
  .meta({ id: "ReachSkippedPlatform" });

/**
 * `record_platform_stats` → `POST /admin/reach/collect` (operationId
 * `recordPlatformStats`).
 *
 * AGENT tier (`adminAuth`, no `operatorGuard`): the box's agent-token reach cron
 * drives it, the `record_health` precedent. Persists ONE daily snapshot — each
 * (platform, metric) upserts idempotently by a `${platform}:${metric}:${yyyy-mm-dd}`
 * id (ON CONFLICT DO NOTHING). Internal write only (no public lastmod moves).
 * Returns the per-platform outcome + the count actually inserted.
 */
export const recordPlatformStats = oc
  .route({
    method: "POST",
    operationId: "recordPlatformStats",
    path: "/admin/reach/collect",
    summary: "Collect + record a daily reach snapshot across every platform",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(
    z.object({
      collected: z.array(CollectedPlatformSchema),
      inserted: z.number().int(),
      ok: z.literal(true),
      skipped: z.array(SkippedPlatformSchema),
    }),
  );

/** The `admin-reach` domain's ops, merged into the root contract by `./index.ts`. */
export const adminReachContract = {
  record_platform_stats: recordPlatformStats,
};
