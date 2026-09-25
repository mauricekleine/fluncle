import { oc } from "@orpc/contract";
import * as z from "zod";

const PlatformStatPointSchema = z
  .object({
    capturedAt: z.string(),
    value: z.number().int(),
  })
  .meta({ id: "PlatformStatPoint" });

const PlatformStatSeriesSchema = z
  .object({
    latest: z.number().int(),
    latestAt: z.string(),
    metric: z.string(),
    platform: z.string(),
    points: z.array(PlatformStatPointSchema),
  })
  .meta({ id: "PlatformStatSeries" });

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

export const reachContract = {
  list_platform_stats: listPlatformStats,
};
