// The oRPC server seam in the Worker — the production rails for the migration
// (docs/orpc-migration-brief.md). Proven end to end on workerd by the spike
// (PR #58); this is that spike made production-grade.
//
//   contract (@fluncle/contracts/orpc)
//     → implement()        — the handler that serves each op (./orpc-auth `base`)
//     → router             — the typed router object (Router type exported)
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

import { contract } from "@fluncle/contracts/orpc";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { implement, ORPCError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { apiErrorResponse } from "./http-errors";
import { resolveLogPageTarget } from "./log-resolver";
import { type OrpcContext } from "./orpc-auth";

// The contract implementer, pinned to the same request-carrying context the admin
// spine uses (./orpc-auth), so one OpenAPIHandler routes public + admin ops off a
// single injected `{ request }`. Public ops attach `.handler` directly; admin ops
// (fan-out phase) chain `.use(adminAuth)` / build on `operatorProcedure` first.
const os = implement(contract).$context<OrpcContext>();

// ── Handlers ───────────────────────────────────────────────────────────────
// One `.handler` per contract op. The handler body is pre-bound to the op's
// Zod I/O, so it cannot return a shape the contract (and thus the spec) doesn't
// promise — that is the drift-proofing the migration is for.

// `get_track` — public read of one finding (or mixtape) by Spotify trackId or
// Log ID. A direct port of the live /api/tracks/{idOrLogId} GET handler:
// resolve, 404 via ORPCError when absent, else the `{ ok: true } & ({ track } |
// { mixtape })` envelope. No auth middleware — it is a public read.
const getTrack = os.get_track.handler(async ({ input }) => {
  try {
    const target = await resolveLogPageTarget(input.idOrLogId);

    if (!target) {
      throw new ORPCError("NOT_FOUND", { message: `No finding for "${input.idOrLogId}"` });
    }

    return target.kind === "mixtape"
      ? ({ mixtape: target.mixtape, ok: true } as const)
      : ({ ok: true, track: target.track } as const);
  } catch (error) {
    // Re-throw oRPC's own errors (the 404 above) so it shapes the response;
    // anything else is an unexpected fault — map it through the shared API error
    // shape's status so behavior matches the TanStack route it replaces.
    if (error instanceof ORPCError) {
      throw error;
    }

    const response = apiErrorResponse(error);

    throw new ORPCError("INTERNAL_SERVER_ERROR", { status: response.status });
  }
});

// The contract router. Grows one op per migrated route; the spec, the validators,
// and the typed client all derive from this object, so they cannot disagree with
// the handlers that implement it.
export const router = os.router({
  get_track: getTrack,
});

/** The router type a client imports (`import type { Router }`) to derive a fully typed client. */
export type Router = typeof router;

// One handler instance, reused across requests. Dual-mounted under `/api/v1` and
// `/api` to preserve the permanent back-compat alias for every migrated route:
// each request is tried against the canonical prefix first, then the bare one.
const handler = new OpenAPIHandler(router);

const PRIMARY_PREFIX = "/api/v1";
const ALIAS_PREFIX = "/api";

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

  return matched ? response : null;
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
