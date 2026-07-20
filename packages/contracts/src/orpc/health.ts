// The `health` domain contract module. Owns every health/liveness op; a future
// wave adds an op here and one import line in `./index.ts`, touching no other
// domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * `get_health` → `GET /health` (operationId `getHealth`).
 *
 * Liveness probe — the "status" relation from /.well-known/api-catalog (RFC
 * 9727). Deliberately cheap: no Turso round-trip.
 *
 * `sha` is the commit SHA of the build currently serving this response — the SAME
 * value Sentry stamps as the release (both read the one build-time constant, so
 * they can never disagree; see `SENTRY_RELEASE` in apps/web sentry-config). It lets
 * a poller tell WHICH deploy is live — the post-deploy probe waits until prod's
 * `sha` equals the pushed commit before sweeping the surfaces. `null` when the build
 * could not resolve a SHA (a shallow checkout with no git and no CI var): an honest
 * absence, never a wrong value.
 */
export const getHealth = oc
  .route({
    method: "GET",
    operationId: "getHealth",
    path: "/health",
    summary: "Liveness probe",
    tags: ["Health"],
  })
  .output(z.object({ ok: z.literal(true), sha: z.string().nullable() }));

/** The `health` domain's ops, merged into the root contract by `./index.ts`. */
export const healthContract = {
  get_health: getHealth,
};
