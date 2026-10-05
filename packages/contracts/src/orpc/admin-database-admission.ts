import { oc } from "@orpc/contract";
import * as z from "zod";

export const DatabaseAdmissionActionSchema = z.enum(["acquire", "cancel", "heartbeat", "release"]);
export const DatabaseAdmissionLaneSchema = z.enum(["heavy-read", "write"]);
export const DatabaseAdmissionOutcomeSchema = z.enum([
  "acquired",
  "cancelled",
  "lost",
  "queued",
  "released",
  "shadow-acquire",
  "shadow-yield",
]);
export const DatabaseAdmissionYieldReasonSchema = z.enum([
  "database-health",
  "direct-read-latency",
  "public-latency",
  "queue",
  "write-latency",
]);

const DatabaseAdmissionInputSchema = z
  .object({
    action: DatabaseAdmissionActionSchema,
    fencingToken: z.number().int().positive().optional(),
    notAfterMs: z.number().int().nonnegative().optional(),
    owner: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9.-]*$/),
    protocolVersion: z.literal(2).optional(),
    runId: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  })
  .refine(
    (input) =>
      input.action === "acquire" || input.action === "cancel" || input.fencingToken !== undefined,
    "heartbeat and release require a fencing token",
  );

export const DatabaseAdmissionResponseSchema = z.object({
  activeConflictCount: z.number().int().nonnegative().nullable(),
  aheadCount: z.number().int().nonnegative().nullable(),
  contenderId: z.string().min(1).max(192),
  enforced: z.boolean(),
  fencingToken: z.number().int().positive().nullable(),
  heartbeatAfterMs: z.number().int().nonnegative(),
  heavyRead: z.boolean(),
  holdMs: z.number().int().nonnegative(),
  lane: DatabaseAdmissionLaneSchema,
  leaseExpiresAtMs: z.number().int().nonnegative().nullable(),
  leaseRemainingMs: z.number().int().nonnegative().nullable(),
  operationId: z.string().min(1).max(64),
  outcome: DatabaseAdmissionOutcomeSchema,
  queueAgeMs: z.number().int().nonnegative(),
  recovered: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().nullable(),
  waitMs: z.number().int().nonnegative(),
  yieldReason: DatabaseAdmissionYieldReasonSchema.nullable(),
});

export type DatabaseAdmissionResponse = z.infer<typeof DatabaseAdmissionResponseSchema>;

export const coordinateDatabaseAdmission = oc
  .route({
    method: "POST",
    operationId: "coordinateDatabaseAdmission",
    path: "/admin/database-admission",
    summary: "Coordinate one registry-classified recurring database operation",
    tags: ["Admin"],
  })
  .input(DatabaseAdmissionInputSchema)
  .output(DatabaseAdmissionResponseSchema);

export const DatabaseWriteProbeOutcomeSchema = z.enum(["failed", "ok", "slow", "stalled"]);

export const DatabaseWriteProbeResponseSchema = z.object({
  latencyMs: z.number().int().nonnegative().nullable(),
  ok: z.literal(true),
  outcome: DatabaseWriteProbeOutcomeSchema,
  recorded: z.boolean(),
});

export type DatabaseWriteProbeResponse = z.infer<typeof DatabaseWriteProbeResponseSchema>;

export const recordDatabaseWriteProbe = oc
  .route({
    method: "POST",
    operationId: "recordDatabaseWriteProbe",
    path: "/admin/database-admission/write-probe",
    summary: "Time one bounded write to the primary database and record it for admission",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(DatabaseWriteProbeResponseSchema);

export const adminDatabaseAdmissionContract = {
  coordinate_database_admission: coordinateDatabaseAdmission,
  record_database_write_probe: recordDatabaseWriteProbe,
};
