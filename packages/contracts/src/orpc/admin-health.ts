import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  OPERATION_RECEIPT_KEY_MAX,
  OPERATION_RECEIPT_KEY_PATTERN,
  OPERATION_RECEIPT_REQUEST_DIGEST_PATTERN,
} from "./admin-operation-receipts.js";

export const HEALTH_SNAPSHOT_PRODUCER_MAX = 64;
export const HEALTH_SNAPSHOT_PRODUCER_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export const HEALTH_SNAPSHOT_CHECKS_MAX = 128;

export const HEALTH_SNAPSHOT_SERVICE_MAX = 64;

export const ServiceHealthStatusSchema = z
  .enum(["ok", "degraded", "down"])
  .meta({ id: "ServiceHealthStatus" });

const HealthCheckSchema = z
  .object({
    latencyMs: z.number().int().nullable(),

    message: z.string().nullable(),

    service: z.string().min(1).max(HEALTH_SNAPSHOT_SERVICE_MAX),
    status: ServiceHealthStatusSchema,

    transitioned: z.boolean(),
  })
  .meta({ id: "HealthCheck" });

export const recordHealth = oc
  .route({
    method: "POST",
    operationId: "recordHealth",
    path: "/admin/health",
    summary: "Record a service-health snapshot for the public status dashboard",
    tags: ["Admin"],
  })
  .input(
    z
      .object({
        at: z.string().max(64).datetime({ offset: true }),
        checks: z.array(HealthCheckSchema).max(HEALTH_SNAPSHOT_CHECKS_MAX),
        operationKey: z
          .string()
          .min(1)
          .max(OPERATION_RECEIPT_KEY_MAX)
          .regex(OPERATION_RECEIPT_KEY_PATTERN)
          .optional(),
        producer: z
          .string()
          .max(HEALTH_SNAPSHOT_PRODUCER_MAX)
          .regex(HEALTH_SNAPSHOT_PRODUCER_PATTERN)
          .optional(),
        requestDigest: z.string().regex(OPERATION_RECEIPT_REQUEST_DIGEST_PATTERN).optional(),
      })
      .refine((input) => {
        const values = [input.operationKey, input.producer, input.requestDigest];
        const supplied = values.filter((value) => value !== undefined).length;

        return (
          supplied === 0 ||
          supplied === values.length ||
          (supplied === 1 && input.operationKey !== undefined)
        );
      }, "supply no receipt metadata, the compatibility operationKey, or all receipt fields"),
  )
  .output(z.object({ ok: z.literal(true) }));

export const adminHealthContract = {
  record_health: recordHealth,
};
