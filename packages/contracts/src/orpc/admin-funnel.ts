import { oc } from "@orpc/contract";
import * as z from "zod";

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

const FunnelLiveQueuesSchema = FunnelQueuesSchema.extend({
  anchorQueueAwaitingAudio: z.number().int(),
  anchorQueueReady: z.number().int(),
}).meta({ id: "FunnelLiveQueues" });

const PublicSurfaceCountsSchema = z
  .object({
    albums: z.number().int(),
    artists: z.number().int(),
    labels: z.number().int(),
    tracks: z.number().int(),
  })
  .meta({ id: "PublicSurfaceCounts" });

const CaptureBacklogSchema = z
  .object({
    authorized: z.number().int(),
    authorizedAnchored: z.number().int(),
    budgetOpen: z.boolean(),
    tiers: z.array(
      z.object({
        anchored: z.number().int(),
        tier: z.number().int(),
        unanchored: z.number().int(),
      }),
    ),
  })
  .meta({ id: "CaptureBacklog" });

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

export const recordCatalogueSnapshot = oc
  .route({
    method: "POST",
    operationId: "recordCatalogueSnapshot",
    path: "/admin/funnel/snapshot",
    summary: "Record today's catalogue-funnel snapshot (idempotent per UTC day)",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(
    z.object({
      backfilledDays: z.array(z.string()),
      ok: z.literal(true),
      snapshot: CatalogueSnapshotRowSchema,
    }),
  );

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
        captureBacklog: CaptureBacklogSchema,
        meters: FunnelMetersSchema,
        publicSurfaces: PublicSurfaceCountsSchema,
        queues: FunnelLiveQueuesSchema,
        stages: FunnelStagesSchema,
      }),
      series: z.array(CatalogueSnapshotRowSchema),
    }),
  );

export const adminFunnelContract = {
  get_funnel: getFunnel,
  record_catalogue_snapshot: recordCatalogueSnapshot,
};
