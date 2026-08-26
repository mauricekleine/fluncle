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
]);

const DatabaseAdmissionInputSchema = z
  .object({
    action: DatabaseAdmissionActionSchema,
    fencingToken: z.number().int().positive().optional(),
    owner: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9.-]*$/),
    runId: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  })
  .refine(
    (input) => input.action === "acquire" || input.fencingToken !== undefined,
    "heartbeat, release, and cancel require a fencing token",
  );

export const DatabaseAdmissionResponseSchema = z.object({
  contenderId: z.string().min(1).max(192),
  enforced: z.boolean(),
  fencingToken: z.number().int().positive().nullable(),
  heartbeatAfterMs: z.number().int().nonnegative(),
  holdMs: z.number().int().nonnegative(),
  lane: DatabaseAdmissionLaneSchema,
  leaseExpiresAtMs: z.number().int().nonnegative().nullable(),
  operationId: z.string().min(1).max(64),
  outcome: DatabaseAdmissionOutcomeSchema,
  queueAgeMs: z.number().int().nonnegative(),
  recovered: z.boolean(),
  waitMs: z.number().int().nonnegative(),
  yieldReason: DatabaseAdmissionYieldReasonSchema.nullable(),
});

export type DatabaseAdmissionResponse = z.infer<typeof DatabaseAdmissionResponseSchema>;

/** Agent-tier coordination endpoint used only by committed recurring units. */
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

export const adminDatabaseAdmissionContract = {
  coordinate_database_admission: coordinateDatabaseAdmission,
};
