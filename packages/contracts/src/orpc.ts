// SPIKE (de-risking, not the migration) — the runtime oRPC contract.
//
// `index.ts` is the package's pure-types source of truth (no runtime). This
// file is the *runtime* contract evolution the RFC's Unit D contemplates: an
// `@orpc/contract` definition whose I/O are Zod schemas, from which the spec,
// the request/response validators, and a typed client all derive. It is kept
// on its own `./orpc` subpath export so the existing pure-types consumers
// (CLI, Raycast, web route typings) never pull in zod/@orpc at runtime.
//
// Scope of the spike: ONE trivial read (`health`) — just enough to prove the
// contract → implement → OpenAPI-generate → fetch-handler-on-workerd chain
// runs. The verb_noun name (`get_health` → operationId `getHealth`) is the
// Convention-B shape the registry would encode.

import { oc } from "@orpc/contract";
import * as z from "zod";

/** The liveness payload. Mirrors today's `GET /api/v1/health` body (`{ ok: true }`). */
export const HealthSchema = z.object({
  ok: z.literal(true),
});

export type Health = z.infer<typeof HealthSchema>;

// One operation. `operationId` is the Convention-B camelCase projection of the
// canonical `get_health` registry name; the REST path mirrors the live route.
export const getHealth = oc
  .route({
    method: "GET",
    operationId: "getHealth",
    path: "/health",
    summary: "Liveness probe",
    tags: ["Meta"],
  })
  .output(HealthSchema);

/**
 * The Fluncle API contract router. Grows one operation per migrated route; the
 * spec, validators, and the typed client all derive from this object, so they
 * cannot disagree with the handlers that implement it.
 */
export const contract = {
  health: getHealth,
};

export type FluncleContract = typeof contract;
