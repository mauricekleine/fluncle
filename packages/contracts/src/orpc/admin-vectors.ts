import { oc } from "@orpc/contract";
import * as z from "zod";

export const VectorServingReasonSchema = z.enum([
  "artifact_contract_mismatch",
  "checkpoint_mismatch",
  "consumer_contract_mismatch",
  "consumer_not_active",
  "consumer_rebuild_incomplete",
  "consumer_unavailable",
  "delta_stale",
  "empty_index",
  "pending_ack",
  "producer_backlog",
  "replica_stale",
  "sonar_not_ok",
  "sonar_unavailable",
  "build_identity_missing",
  "validation_failed",
]);
export type VectorServingReason = z.infer<typeof VectorServingReasonSchema>;

const ReadinessSchema = z.object({
  ready: z.boolean(),
  reasons: z.array(VectorServingReasonSchema),
});

export const VectorServingStatusSchema = z.object({
  commissioning: ReadinessSchema,
  enabled: z.boolean(),
  evidence: z.object({
    artifactVersion: z.string().nullable(),
    checkpoint: z.number().int().nonnegative().nullable(),
    checkpointedAt: z.string().nullable(),
    commit: z.string().nullable(),
    consumerAppliedThroughSeq: z.number().int().nonnegative().nullable(),
    consumerHeadSeq: z.number().int().nonnegative().nullable(),
    consumerId: z.string().nullable(),
    consumerState: z.enum(["active", "inactive", "rebuilding"]).nullable(),
    deltaAgeSeconds: z.number().int().nonnegative().nullable(),
    deltaBacklog: z.number().int().nonnegative().nullable(),
    pendingAck: z.boolean().nullable(),
    replicaLagSeconds: z.number().int().nullable(),
    tracks: z.number().int().nonnegative().nullable(),
    validation: z.enum(["last_attempt_failed", "valid"]).nullable(),
  }),
  runtime: ReadinessSchema,
  target: z.literal("tracks"),
});
export type VectorServingStatus = z.infer<typeof VectorServingStatusSchema>;

const VectorServingResponseSchema = z.object({
  ok: z.literal(true),
  status: VectorServingStatusSchema,
});

export const getVectorServing = oc
  .route({
    method: "GET",
    operationId: "getVectorServing",
    path: "/admin/vectors/tracks/serving",
    summary: "Read track vector-serving readiness",
    tags: ["Admin"],
  })
  .output(VectorServingResponseSchema);

export const setVectorServing = oc
  .route({
    method: "PUT",
    operationId: "setVectorServing",
    path: "/admin/vectors/tracks/serving",
    summary: "Enable or disable track vector serving",
    tags: ["Admin"],
  })
  .input(z.object({ enabled: z.boolean() }))
  .output(VectorServingResponseSchema);

export const adminVectorsContract = {
  get_vector_serving: getVectorServing,
  set_vector_serving: setVectorServing,
};
