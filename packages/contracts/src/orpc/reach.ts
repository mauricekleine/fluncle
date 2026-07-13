// The `reach` domain contract module — the PUBLIC read behind the /reach page:
// Fluncle's numbers across every platform, over time. The read half of the
// `record_health` noun-swap (its write is `admin-reach`); one bounded, grouped page
// read of the append-only `platform_stats` ledger.
//
//   - `list_platform_stats` — GET /reach/stats, PUBLIC tier. Per (platform, metric)
//     the latest value + the bounded day-by-day series (last N days, default 90).
//     Every number is already public on its own platform, so the read is anonymous
//     by design.

import { oc } from "@orpc/contract";
import * as z from "zod";

/** One point in a metric's series — a day's captured value. */
const PlatformStatPointSchema = z
  .object({
    capturedAt: z.string(),
    value: z.number().int(),
  })
  .meta({ id: "PlatformStatPoint" });

/** One (platform, metric) series: the latest value + the bounded points. */
const PlatformStatSeriesSchema = z
  .object({
    latest: z.number().int(),
    latestAt: z.string(),
    metric: z.string(),
    platform: z.string(),
    points: z.array(PlatformStatPointSchema),
  })
  .meta({ id: "PlatformStatSeries" });

/**
 * `list_platform_stats` → `GET /reach/stats` (operationId `listPlatformStats`).
 *
 * PUBLIC tier (no auth). `windowDays` is a tolerant optional STRING (the query-param
 * convention — a raw string parsed + clamped in-handler, default 90, max 365, so a
 * non-numeric query never rejects). Returns every series within the window, grouped
 * for one page read.
 */
export const listPlatformStats = oc
  .route({
    method: "GET",
    operationId: "listPlatformStats",
    path: "/reach/stats",
    summary: "Fluncle's numbers across every platform, over time",
    tags: ["Reach"],
  })
  .input(z.object({ windowDays: z.string().optional() }))
  .output(
    z.object({
      series: z.array(PlatformStatSeriesSchema),
      windowDays: z.number().int(),
    }),
  );

/** The `reach` domain's ops, merged into the root contract by `./index.ts`. */
export const reachContract = {
  list_platform_stats: listPlatformStats,
};
