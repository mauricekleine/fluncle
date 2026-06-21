// The oRPC server seam in the Worker — the production rails for the migration
// (docs/orpc-migration-brief.md). Proven end to end on workerd by the spike
// (PR #58); this is that spike made production-grade.
//
//   contract (@fluncle/contracts/orpc)
//     → implement()        — the implementer handed to each domain module
//     → router             — the typed router object, composed per-domain
//     → OpenAPIHandler      — a Web-Standard fetch handler (no node:http / node:fs)
//     → OpenAPIGenerator    — the OpenAPI 3.1 doc, generated from the same contracts
//
// All adapters are fetch/Web-Standard; none pull in `node:http`, `node:fs`, or FS
// access, so they run on workerd under `nodejs_compat`.
//
// The incremental seam: `handleOrpc` returns `null` when oRPC matched no procedure
// (the handler's `matched: false`), so `server.ts` falls the request through to the
// existing TanStack Start router untouched. oRPC owns only the operations it has
// contracts for; TanStack owns everything else, in one Worker, indefinitely.
//
// COMPOSABLE BY DOMAIN. The handlers live in per-domain modules under `./orpc/`
// (`./orpc/tracks.ts`, `./orpc/health.ts`, …); each is a factory taking the shared
// implementer and returning its ops. This root builds that implementer, spreads
// every domain's handlers into one `router`, and keeps the mount / error-encoder /
// OpenAPI wiring here. A new wave adds `./orpc/<domain>.ts` (+ its contract module)
// and one spread line below — no other domain's file is touched.

import { contract } from "@fluncle/contracts/orpc";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { implement, ORPCError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { type OrpcContext } from "./orpc-auth";
import { isApiFaultData } from "./orpc/_shared";
import { healthHandlers } from "./orpc/health";
import { mixtapesHandlers } from "./orpc/mixtapes";
import { newsletterHandlers } from "./orpc/newsletter";
import { searchHandlers } from "./orpc/search";
import { storiesHandlers } from "./orpc/stories";
import { submissionsHandlers } from "./orpc/submissions";
import { tracksHandlers } from "./orpc/tracks";

// The contract implementer, pinned to the same request-carrying context the admin
// spine uses (./orpc-auth), so one OpenAPIHandler routes public + admin ops off a
// single injected `{ request }`. Public ops attach `.handler` directly (in their
// domain module); admin ops (later wave) build on `operatorProcedure` first.
const os = implement(contract).$context<OrpcContext>();

// ── Router ───────────────────────────────────────────────────────────────────
// Composed from the per-domain handler factories. The spec, the validators, and
// the typed client all derive from this object, so they cannot disagree with the
// handlers that implement it. Each domain's handler body is pre-bound to its op's
// Zod I/O, so it cannot return a shape the contract (and thus the spec) doesn't
// promise — that is the drift-proofing the migration is for.
//
// Add a domain: import its `*Handlers(os)` factory and spread it here.
export const router = os.router({
  ...healthHandlers(os),
  ...mixtapesHandlers(os),
  ...newsletterHandlers(os),
  ...searchHandlers(os),
  ...storiesHandlers(os),
  ...submissionsHandlers(os),
  ...tracksHandlers(os),
});

/** The router type a client imports (`import type { Router }`) to derive a fully typed client. */
export type Router = typeof router;

// ── Error wire-shape parity ──────────────────────────────────────────────────
// Every converted route inherits this. oRPC's default error body is its own
// envelope (`{ defined, code, status, message, data }`); the live API speaks the
// `jsonError` shape — body `{ code, message, ok: false }` with the status on the
// Response (apps/web/src/lib/server/env.ts → http-errors.ts). Public consumers
// (the CLI, the enrichment agent, the web app) read `{ ok: false, code, message }`,
// so we re-encode every thrown `ORPCError` into that shape here, at the rails, and
// every fan-out route is wire-compatible by construction. oRPC still drives the
// HTTP status off `error.status`; the encoder only rewrites the body. The fault
// converter half (`apiFault`/`isApiFaultData`) lives in ./orpc/_shared so the
// domain handlers can produce a wire-compatible fault from their catch.

// oRPC codes are SCREAMING_SNAKE; the API's `code` field is lower_snake. Map the
// load-bearing ones to the exact codes the legacy routes emit; everything else
// lower-cases by convention so a new code never leaks the oRPC spelling.
const ORPC_CODE_TO_API_CODE: Record<string, string> = {
  // oRPC raises BAD_REQUEST for input (Zod) validation failures; the API's own
  // bad-body path is `invalid_request` (http-errors.ts → parseJsonBody).
  BAD_REQUEST: "invalid_request",
  // A generic fault that reached the rails as a bare 500 → `error` (http-errors.ts).
  INTERNAL_SERVER_ERROR: "error",
  // `trackNotFoundResponse` → `not_found` (http-errors.ts).
  NOT_FOUND: "not_found",
};

function orpcCodeToApiCode(code: string): string {
  return ORPC_CODE_TO_API_CODE[code] ?? code.toLowerCase();
}

/**
 * Re-encode a thrown `ORPCError` into the legacy `jsonError` body shape
 * (`{ code, message, ok: false }`). Returned to `OpenAPIHandler` as the response
 * body; the HTTP status stays `error.status`, so a 404 stays 404, a 500 stays 500.
 * A fault carrying `ApiFaultData` (from `apiFault`, or a custom-coded read like the
 * random-track 404) wins so the exact code/message is preserved; otherwise the
 * code maps off the oRPC code.
 */
function encodeErrorBody(error: ORPCError<string, unknown>) {
  if (isApiFaultData(error.data)) {
    return {
      code: error.data.apiCode,
      message: error.data.apiMessage,
      ok: false as const,
    };
  }

  return {
    code: orpcCodeToApiCode(error.code),
    message: error.message,
    ok: false as const,
  };
}

// One handler instance, reused across requests. Dual-mounted under `/api/v1` and
// `/api` to preserve the permanent back-compat alias for every migrated route:
// each request is tried against the canonical prefix first, then the bare one.
// `customErrorResponseBodyEncoder` rewrites every thrown error into the legacy
// `jsonError` body (see above), so error-shape parity is a rails concern, not a
// per-handler one.
const handler = new OpenAPIHandler(router, {
  customErrorResponseBodyEncoder: encodeErrorBody,
});

const PRIMARY_PREFIX = "/api/v1";
const ALIAS_PREFIX = "/api";

// The live /api/health route sets `Cache-Control: no-store` so a liveness poll is
// never cached. oRPC owns the response framing, so the header is reapplied here on
// a matched health response — parity without a per-handler header plugin.
const HEALTH_SUFFIX = "/health";

/**
 * Try to serve `request` with oRPC. Returns the `Response` when a procedure
 * matched, or `null` to fall through to the existing TanStack router (the
 * `matched: false` seam). Mounted at both `/api/v1` and `/api`; the canonical
 * versioned prefix is tried unless the path is under the bare alias.
 */
export async function handleOrpc(request: Request): Promise<Response | null> {
  const url = new URL(request.url);

  // Only the /api surface is ours to consider; everything else (HTML, assets,
  // /docs, the MCP/discovery seams) is never an oRPC request, so skip the work.
  if (url.pathname !== ALIAS_PREFIX && !url.pathname.startsWith(`${ALIAS_PREFIX}/`)) {
    return null;
  }

  const prefix = url.pathname.startsWith(`${PRIMARY_PREFIX}/`) ? PRIMARY_PREFIX : ALIAS_PREFIX;

  const { matched, response } = await handler.handle(request, {
    context: { request },
    prefix,
  });

  if (!matched) {
    return null;
  }

  // Reapply the liveness probe's no-store directive (the one header the live
  // route set that oRPC's framing would otherwise drop).
  if (url.pathname === `${prefix}${HEALTH_SUFFIX}`) {
    response.headers.set("Cache-Control", "no-store");
  }

  return response;
}

// The spec, generated from the router — the same contracts that serve the
// requests. In a later phase this replaces the hand-maintained
// `apps/web/public/openapi.json`; for now it is exposed at a diffable temp route
// (see routes/api/v1/orpc-openapi[.]json.ts) so the generated fragment can be
// compared against the static spec before the flip.
const generator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter()],
});

export async function generateOpenApiDocument() {
  return generator.generate(router, {
    info: {
      title: "Fluncle API",
      version: "1.0.0",
    },
    servers: [{ url: "/api/v1" }],
  });
}
