// The `health` domain contract module. Owns every health/liveness op; a future
// wave adds an op here and one import line in `./index.ts`, touching no other
// domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * `get_health` → `GET /health` (operationId `getHealth`).
 *
 * Liveness probe — the "status" relation from /.well-known/api-catalog (RFC
 * 9727). Deliberately cheap: no Turso round-trip. The body is the bare `{ ok:
 * true }` envelope the live route emits.
 */
export const getHealth = oc
  .route({
    method: "GET",
    operationId: "getHealth",
    path: "/health",
    summary: "Liveness probe",
    tags: ["Health"],
  })
  .output(z.object({ ok: z.literal(true) }));

/** The `health` domain's ops, merged into the root contract by `./index.ts`. */
export const healthContract = {
  get_health: getHealth,
};
