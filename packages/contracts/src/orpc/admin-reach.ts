import { oc } from "@orpc/contract";
import * as z from "zod";

const CollectedPlatformSchema = z
  .object({
    metrics: z.array(z.string()),
    platform: z.string(),
  })
  .meta({ id: "ReachCollectedPlatform" });

const SkippedPlatformSchema = z
  .object({
    kind: z.enum(["empty", "unconfigured"]),
    platform: z.string(),
    reason: z.string(),
  })
  .meta({ id: "ReachSkippedPlatform" });

const FailedPlatformSchema = z
  .object({
    platform: z.string(),
    reason: z.string(),
  })
  .meta({ id: "ReachFailedPlatform" });

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
      failed: z.array(FailedPlatformSchema),
      inserted: z.number().int(),
      ok: z.literal(true),
      skipped: z.array(SkippedPlatformSchema),
    }),
  );

export const adminReachContract = {
  record_platform_stats: recordPlatformStats,
};
