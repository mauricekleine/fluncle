// SPIKE (de-risking, not the migration) — the oRPC server seam in the Worker.
//
// Proves the RFC's Unit D chain end to end on workerd:
//   contract (packages/contracts/orpc)
//     → implement()        — the handler that serves it
//     → router             — the typed router object
//     → OpenAPIHandler      — a Web-Standard fetch handler (no Node http server)
//     → OpenAPIGenerator    — the spec, generated from the same contracts
//
// All four imports are fetch/Web-Standard adapters; none pull in `node:http`,
// `node:fs`, or any FS access — they run on workerd under `nodejs_compat`.
//
// The incremental seam: `handleOrpc` returns `null` when oRPC matched no
// procedure (the handler's `matched: false`), so `server.ts` falls the request
// through to the existing TanStack Start router untouched. oRPC owns only the
// operations it has contracts for; TanStack owns everything else, in one Worker.

import { contract } from "@fluncle/contracts/orpc";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { implement } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";

// Implement the contract. `implement(contract)` yields a builder pre-bound to
// each contract op's I/O; `.handler` supplies the body. The output is
// validated against `HealthSchema`, so the handler cannot return a shape the
// spec doesn't promise — that is the drift-proofing the RFC wants.
const os = implement(contract);

const health = os.health.handler(() => ({ ok: true as const }));

export const router = os.router({
  health,
});

/** The router type a client imports (`import type { Router }`) to derive a fully typed client. */
export type Router = typeof router;

// One handler instance, reused across requests. Mounting under both `/api/v1`
// and `/api` is how the permanent dual-mount alias is preserved for migrated
// routes (each request is tried against the canonical prefix first, then the
// back-compat one).
const handler = new OpenAPIHandler(router);

const PRIMARY_PREFIX = "/api/v1/orpc";
const ALIAS_PREFIX = "/api/orpc";

/**
 * Try to serve `request` with oRPC. Returns the `Response` when a procedure
 * matched, or `null` to fall through to the existing router (the `matched:
 * false` seam). Scoped to an `/orpc` sub-prefix during the spike so it can sit
 * beside the live `/api/v1/*` TanStack routes without intercepting them.
 */
export async function handleOrpc(request: Request): Promise<Response | null> {
  const url = new URL(request.url);

  const prefix =
    url.pathname.startsWith(`${ALIAS_PREFIX}/`) || url.pathname === ALIAS_PREFIX
      ? ALIAS_PREFIX
      : PRIMARY_PREFIX;

  const { matched, response } = await handler.handle(request, {
    context: {},
    prefix,
  });

  return matched ? response : null;
}

// The spec, generated from the router — the same contracts that serve the
// requests. This is what `/api/v1/openapi.json` would serve in the full
// migration (replacing the hand-maintained `public/openapi.json`).
const generator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter()],
});

export async function generateOpenApiDocument() {
  return generator.generate(router, {
    info: {
      title: "Fluncle API (oRPC spike)",
      version: "0.0.0",
    },
    servers: [{ url: "/api/v1/orpc" }],
  });
}
