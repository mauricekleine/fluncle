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
import { resolveLogPageTarget } from "./log-resolver";
import { type OrpcContext } from "./orpc-auth";
import { ApiError } from "./spotify";

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
    // Re-throw oRPC's own errors (the 404 above) so the rails encoder shapes the
    // response; anything else is an unexpected fault — convert it through the
    // shared `apiFault` helper so its status, code, and message match the
    // TanStack route it replaces.
    if (error instanceof ORPCError) {
      throw error;
    }

    throw apiFault(error);
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

// ── Error wire-shape parity ──────────────────────────────────────────────────
// Every converted route inherits this. oRPC's default error body is its own
// envelope (`{ defined, code, status, message, data }`); the live API speaks the
// `jsonError` shape — body `{ code, message, ok: false }` with the status on the
// Response (apps/web/src/lib/server/env.ts → http-errors.ts). Public consumers
// (the CLI, the enrichment agent, the web app) read `{ ok: false, code, message }`,
// so we re-encode every thrown `ORPCError` into that shape here, at the rails, and
// every fan-out route is wire-compatible by construction. oRPC still drives the
// HTTP status off `error.status`; the encoder only rewrites the body.

// The API `code`/`message` an `ORPCError` can carry through to the wire when the
// thrown code itself can't say them. Faults converted from an `ApiError` (e.g.
// `note_too_long` at 422) or a generic 500 stash their legacy `{ code, message }`
// here so the encoder reproduces the exact `jsonError` body, not a lossy mapping.
type ApiFaultData = { apiCode: string; apiMessage: string };

function isApiFaultData(data: unknown): data is ApiFaultData {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as ApiFaultData).apiCode === "string" &&
    typeof (data as ApiFaultData).apiMessage === "string"
  );
}

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
 * Convert an unexpected (non-`ORPCError`) fault into an `ORPCError` whose status,
 * code, and message match the legacy `apiErrorResponse` (http-errors.ts): an
 * `ApiError` keeps its own status/code/message; anything else is a 500 with code
 * `error`. The legacy `{ code, message }` ride along in `data` so the rails
 * encoder reproduces the exact `jsonError` body. Shared so every converted
 * handler's catch can `throw apiFault(error)` for one wire-compatible 500 path.
 */
function apiFault(error: unknown): ORPCError<string, ApiFaultData> {
  const apiCode = error instanceof ApiError ? error.code : "error";
  const apiMessage = error instanceof Error ? error.message : String(error);
  const status = error instanceof ApiError ? error.status : 500;

  return new ORPCError("INTERNAL_SERVER_ERROR", {
    data: { apiCode, apiMessage },
    message: apiMessage,
    status,
  });
}

/**
 * Re-encode a thrown `ORPCError` into the legacy `jsonError` body shape
 * (`{ code, message, ok: false }`). Returned to `OpenAPIHandler` as the response
 * body; the HTTP status stays `error.status`, so a 404 stays 404, a 500 stays 500.
 * A fault carrying `ApiFaultData` (from `apiFault`) wins so a converted `ApiError`
 * keeps its exact code/message; otherwise the code maps off the oRPC code.
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
