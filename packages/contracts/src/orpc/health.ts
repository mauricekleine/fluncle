import { oc } from "@orpc/contract";
import * as z from "zod";

export const getHealth = oc
  .route({
    method: "GET",
    operationId: "getHealth",
    path: "/health",
    summary: "Liveness probe",
    tags: ["Health"],
  })
  .output(z.object({ ok: z.literal(true), sha: z.string().nullable() }));

export const healthContract = {
  get_health: getHealth,
};
