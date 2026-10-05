import { oc, type OpenAPI } from "@orpc/contract";
import * as z from "zod";

const databaseTiming = {
  latencyMs: z.number().nonnegative(),
  queueWaitMs: z.number().nonnegative().nullable(),
};

export const HealthDatabaseDownSchema = z.object({
  database: z.object({ ...databaseTiming, status: z.literal("down") }),
  ok: z.literal(false),
  sha: z.string().nullable(),
});

export const getHealth = oc
  .errors({ SERVICE_UNAVAILABLE: { data: HealthDatabaseDownSchema } })
  .route({
    method: "GET",
    operationId: "getHealth",
    path: "/health",
    spec: (current) => ({
      ...current,
      responses: {
        ...current.responses,
        "503": {
          content: {
            "application/json": {
              schema: z.toJSONSchema(HealthDatabaseDownSchema) as OpenAPI.SchemaObject,
            },
          },
          description: "The primary database probe failed or exceeded its budget.",
        },
      },
    }),
    summary: "Worker and primary database health",
    tags: ["Health"],
  })
  .output(
    z.object({
      database: z.object({ ...databaseTiming, status: z.enum(["ok", "degraded"]) }),
      ok: z.literal(true),
      sha: z.string().nullable(),
    }),
  );

export const healthContract = {
  get_health: getHealth,
};
