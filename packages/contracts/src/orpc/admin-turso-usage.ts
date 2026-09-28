import { oc } from "@orpc/contract";
import * as z from "zod";

export const MAX_TURSO_USAGE_DATABASES = 500;

export const TURSO_USAGE_THRESHOLD_MIN_USD = 1;

export const TURSO_USAGE_THRESHOLD_MAX_USD = 100_000;

const Count = z.number().int().min(0);

const CycleKey = z.string().regex(/^\d{4}-\d{2}$/);

export const TursoUsageResourceKeySchema = z.enum([
  "rowsRead",
  "rowsWritten",
  "storage",
  "embeddedSyncs",
]);

export const TursoUsageRateBasisSchema = z.enum(["recent", "cycle-to-date", "none"]);

export const TursoUsageTotalsSchema = z
  .object({
    bytesSynced: Count,
    rowsRead: Count,
    rowsWritten: Count,
    storageBytes: Count,
  })
  .meta({ id: "TursoUsageTotals" });

export const TursoDatabaseUsageSchema = TursoUsageTotalsSchema.extend({
  name: z.string().min(1).max(256),
}).meta({ id: "TursoDatabaseUsage" });

export const TursoUsageResourceSchema = z
  .object({
    dailyRate: z.number().min(0),
    included: z.number().min(0),
    key: TursoUsageResourceKeySchema,
    overageUsd: z.number().min(0),
    projectedOverageUsd: z.number().min(0),
    projectedUsed: z.number().min(0),
    unitSize: z.number().positive(),
    usdPerUnit: z.number().min(0),
    used: z.number().min(0),
  })
  .meta({ id: "TursoUsageResource" });

export const TursoAttributedDatabaseSchema = TursoDatabaseUsageSchema.extend({
  attributedOverageUsd: z.number().min(0),
}).meta({ id: "TursoAttributedDatabase" });

export const TursoUsageSnapshotSchema = z
  .object({
    baseUsd: z.number().min(0),
    cycle: CycleKey,
    cycleEnd: z.string(),
    cycleStart: z.string(),
    databases: z.array(TursoAttributedDatabaseSchema),
    observedAt: z.string(),
    overageUsd: z.number().min(0),
    overagesEnabled: z.boolean(),
    plan: z.string(),
    priceSource: z.string(),
    priceTableVersion: z.string(),
    priced: z.boolean(),
    projectedBillUsd: z.number().min(0),
    projectedOverageUsd: z.number().min(0),
    rateBasis: TursoUsageRateBasisSchema,
    rateWindowHours: z.number().min(0).nullable(),
    resources: z.array(TursoUsageResourceSchema),
    upcomingInvoiceUsd: z.number().min(0).nullable(),
  })
  .meta({ id: "TursoUsageSnapshot" });

export const TursoUsageHistoryDaySchema = z
  .object({
    bytesSynced: Count,
    day: z.string(),
    overageUsd: z.number().min(0),
    projectedOverageUsd: z.number().min(0),
    rowsRead: Count,
    rowsWritten: Count,
    storageBytes: Count,
  })
  .meta({ id: "TursoUsageHistoryDay" });

export const TursoUsageAlertSchema = z
  .object({
    cycle: CycleKey,
    deliveredAt: z.string().nullable(),
    levelUsd: z.number().positive(),
    projectedOverageUsd: z.number().min(0),
    raisedAt: z.string(),
  })
  .meta({ id: "TursoUsageAlert" });

export const TursoUsageAlertKeySchema = z
  .object({
    cycle: CycleKey,
    levelUsd: z.number().positive(),
  })
  .meta({ id: "TursoUsageAlertKey" });

export const recordTursoUsage = oc
  .route({
    method: "POST",
    operationId: "recordTursoUsage",
    path: "/admin/costs/turso-usage",
    summary: "Record one Turso platform usage reading and price it against the plan",
    tags: ["Admin"],
  })
  .input(
    z.object({
      databases: z.array(TursoDatabaseUsageSchema).max(MAX_TURSO_USAGE_DATABASES),
      observedAt: z.string().min(1).max(64),
      plan: z.object({
        name: z.string().min(1).max(64),
        overages: z.boolean(),
      }),
      upcomingInvoiceUsd: z.number().min(0).nullable(),
      usage: TursoUsageTotalsSchema,
    }),
  )
  .output(
    z.object({
      ok: z.literal(true),
      pendingAlerts: z.array(TursoUsageAlertSchema),
      snapshot: TursoUsageSnapshotSchema,
      stored: z.boolean(),
      thresholdUsd: z.number().positive(),
    }),
  );

export const getTursoUsage = oc
  .route({
    method: "GET",
    operationId: "getTursoUsage",
    path: "/admin/costs/turso-usage",
    summary: "The latest priced Turso usage reading, its per-day history, and this cycle's alerts",
    tags: ["Admin"],
  })
  .output(
    z.object({
      alerts: z.array(TursoUsageAlertSchema),
      available: z.boolean(),
      history: z.array(TursoUsageHistoryDaySchema),
      latest: TursoUsageSnapshotSchema.nullable(),
      ok: z.literal(true),
      thresholdUsd: z.number().positive(),
    }),
  );

export const acknowledgeTursoUsageAlerts = oc
  .route({
    method: "PUT",
    operationId: "acknowledgeTursoUsageAlerts",
    path: "/admin/costs/turso-usage/alerts",
    summary: "Mark Turso overage alerts as delivered, once their Discord post has landed",
    tags: ["Admin"],
  })
  .input(z.object({ alerts: z.array(TursoUsageAlertKeySchema).min(1).max(20) }))
  .output(z.object({ acknowledged: z.number().int().min(0), ok: z.literal(true) }));

export const setTursoUsageThreshold = oc
  .route({
    method: "PUT",
    operationId: "setTursoUsageThreshold",
    path: "/admin/costs/turso-usage/threshold",
    summary: "Set the projected Turso overage that raises a Discord alert (operator)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      thresholdUsd: z
        .number()
        .min(TURSO_USAGE_THRESHOLD_MIN_USD)
        .max(TURSO_USAGE_THRESHOLD_MAX_USD),
    }),
  )
  .output(z.object({ ok: z.literal(true), thresholdUsd: z.number().positive() }));

export const adminTursoUsageContract = {
  acknowledge_turso_usage_alerts: acknowledgeTursoUsageAlerts,
  get_turso_usage: getTursoUsage,
  record_turso_usage: recordTursoUsage,
  set_turso_usage_threshold: setTursoUsageThreshold,
};
