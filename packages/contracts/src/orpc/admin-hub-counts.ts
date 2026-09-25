import { oc } from "@orpc/contract";
import * as z from "zod";

const HubCountsTableResultSchema = z
  .object({
    corrected: z.number(),

    deferred: z.number(),
  })
  .meta({ id: "HubCountsTableResult" });

const HubCountsReconcileCursorSchema = z
  .object({
    afterId: z.string().min(1).max(512).nullable(),

    table: z.enum(["labels", "albums", "artists"]),
  })
  .meta({ id: "HubCountsReconcileCursor" });

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
      cursor: HubCountsReconcileCursorSchema.optional(),

      pageLimit: z.number().int().min(1).max(20).optional(),
    }),
  )
  .output(
    z.object({
      albums: HubCountsTableResultSchema,
      artists: HubCountsTableResultSchema,
      labels: HubCountsTableResultSchema,

      next: HubCountsReconcileCursorSchema.nullable(),
      ok: z.literal(true),

      pages: z.number(),

      tookMs: z.number(),
    }),
  );

export const adminHubCountsContract = {
  reconcile_hub_counts: reconcileHubCounts,
};
