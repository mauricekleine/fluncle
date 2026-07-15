// The oRPC server seam in the Worker — the production rails for the migration.
// Proven end to end on workerd by the spike
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
import { adminAlbumsHandlers } from "./orpc/admin-albums";
import { adminArtistsHandlers } from "./orpc/admin-artists";
import { adminAttentionHandlers } from "./orpc/admin-attention";
import { adminBackfillsHandlers } from "./orpc/admin-backfills";
import { adminCatalogueHandlers } from "./orpc/admin-catalogue";
import { adminCostsHandlers } from "./orpc/admin-costs";
import { adminGalaxiesHandlers } from "./orpc/admin-galaxies";
import { adminPromptsHandlers } from "./orpc/admin-prompts";
import { adminReachHandlers } from "./orpc/admin-reach";
import { artistsHandlers } from "./orpc/artists";
import { galaxiesHandlers } from "./orpc/galaxies";
import { graphHandlers } from "./orpc/graph";
import { adminEditionsHandlers } from "./orpc/admin-editions";
import { adminHealthHandlers } from "./orpc/admin-health";
import { adminLabelsHandlers } from "./orpc/admin-labels";
import { adminLogbookHandlers } from "./orpc/admin-logbook";
import { adminMigrationsHandlers } from "./orpc/admin-migrations";
import { adminMixtapesHandlers } from "./orpc/admin-mixtapes";
import { adminNotesHandlers } from "./orpc/admin-notes";
import { adminObservationsHandlers } from "./orpc/admin-observations";
import { adminRecordingsHandlers } from "./orpc/admin-recordings";
import { adminSocialHandlers } from "./orpc/admin-social";
import { adminSubmissionsHandlers } from "./orpc/admin-submissions";
import { adminSubscriptionsHandlers } from "./orpc/admin-subscriptions";
import { adminTokensHandlers } from "./orpc/admin-tokens";
import { adminTracksHandlers } from "./orpc/admin-tracks";
import { adminTwitchHandlers } from "./orpc/admin-twitch";
import { devicesHandlers } from "./orpc/devices";
import { editionsHandlers } from "./orpc/editions";
import { healthHandlers } from "./orpc/health";
import { meHandlers } from "./orpc/me";
import { meGalaxyHandlers } from "./orpc/me-galaxy";
import { mePreferencesHandlers } from "./orpc/me-preferences";
import { meSavedHandlers } from "./orpc/me-saved";
import { meSetsHandlers } from "./orpc/me-sets";
import { mixHandlers } from "./orpc/mix";
import { mixtapesHandlers } from "./orpc/mixtapes";
import { newsletterHandlers } from "./orpc/newsletter";
import { radioHandlers } from "./orpc/radio";
import { reachHandlers } from "./orpc/reach";
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
  ...adminAlbumsHandlers(os),
  ...adminArtistsHandlers(os),
  ...adminAttentionHandlers(os),
  ...adminBackfillsHandlers(os),
  ...adminCatalogueHandlers(os),
  ...adminCostsHandlers(os),
  ...adminGalaxiesHandlers(os),
  ...adminPromptsHandlers(os),
  ...adminReachHandlers(os),
  ...artistsHandlers(os),
  ...galaxiesHandlers(os),
  ...graphHandlers(os),
  ...adminEditionsHandlers(os),
  ...adminHealthHandlers(os),
  ...adminLabelsHandlers(os),
  ...adminLogbookHandlers(os),
  ...adminMigrationsHandlers(os),
  ...adminMixtapesHandlers(os),
  ...adminNotesHandlers(os),
  ...adminObservationsHandlers(os),
  ...adminRecordingsHandlers(os),
  ...adminSocialHandlers(os),
  ...adminSubmissionsHandlers(os),
  ...adminSubscriptionsHandlers(os),
  ...adminTokensHandlers(os),
  ...adminTracksHandlers(os),
  ...adminTwitchHandlers(os),
  ...devicesHandlers(os),
  ...editionsHandlers(os),
  ...healthHandlers(os),
  ...meHandlers(os),
  ...meGalaxyHandlers(os),
  ...mePreferencesHandlers(os),
  ...meSavedHandlers(os),
  ...meSetsHandlers(os),
  ...mixHandlers(os),
  ...mixtapesHandlers(os),
  ...newsletterHandlers(os),
  ...radioHandlers(os),
  ...reachHandlers(os),
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
// requests. This is the document served at /api/v1/openapi.json (Scalar + Postman
// read it); it replaced the hand-maintained `apps/web/public/openapi.json`, so the
// spec can never drift from the handlers that implement it.
const generator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter()],
});

// The PUBLIC spec exposes ONLY the public operations; the admin tier stays OFF the
// public OpenAPI document — admin reads/writes stay OFF the public OpenAPI spec.
// The single `contract` router holds BOTH public and
// admin ops (one OpenAPIHandler serves them all), so the generated public doc is
// drawn from the same router with a path-prefix `filter`: every admin op lives
// under `/admin/*` (the structural truth that also drives routing), so excluding
// that prefix yields exactly the public surface. A new admin op is invisible to the
// public spec by construction — it cannot leak by a forgotten tag.
const ADMIN_PATH_PREFIX = "/admin/";

// ── Shared error response ────────────────────────────────────────────────────
// The generator documents only the SUCCESS response per op (the contracts carry no
// type-safe `.errors()`, so oRPC's `customErrorResponseBodySchema` hook never fires).
// But every public op CAN fault, and when it does the rails encoder
// (`encodeErrorBody` above) rewrites the body into the legacy `jsonError` envelope —
// `{ code, message, ok: false }`, status on the Response (env.ts → `jsonError`).
// Document that uniform 4xx/5xx fault shape once, as a shared component, and attach
// it as the `default` response on every public operation, so error shapes are part
// of the published spec again (the static `public/openapi.json` carried per-op
// 400/429 docs; the generated one lost them). The shape MUST mirror the encoder's
// output exactly — no invented fields — or the spec lies about the wire.
const ERROR_SCHEMA_NAME = "Error";
const ERROR_SCHEMA_REF = `#/components/schemas/${ERROR_SCHEMA_NAME}`;

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

// Inferred from `OpenAPIGenerator.generate` so the in-place edits stay type-checked
// against the generator's return type rather than a hand-rolled shape. The schema +
// response value types are derived from the document so the injected component and
// `default` response satisfy the exact (V3/V3.1-intersected) member types the doc's
// `components.schemas` and `operation.responses` maps expect.
type GeneratedDocument = Awaited<ReturnType<typeof generator.generate>>;
type SchemaValue = NonNullable<NonNullable<GeneratedDocument["components"]>["schemas"]>[string];
type PathItem = NonNullable<GeneratedDocument["paths"]>[string];
type Operation = NonNullable<NonNullable<PathItem>["get"]>;
type ResponseValue = NonNullable<Operation["responses"]>[string];

// The exact body the rails encoder (`encodeErrorBody`) emits, which is the legacy
// `jsonError(status, code, message)` shape (env.ts): `code` (the lower_snake API
// code, e.g. `not_found`, `invalid_request`, `track_not_found`), a human `message`,
// and `ok` pinned `false` to discriminate it from every success envelope.
const ERROR_SCHEMA: SchemaValue = {
  additionalProperties: false,
  description:
    "The uniform fault envelope every operation returns on a 4xx/5xx. The HTTP status carries the error class; the body identifies it with a stable lower_snake `code`, a human-readable `message`, and `ok: false` so it can be discriminated from a success envelope.",
  properties: {
    code: {
      description: "A stable, machine-readable error code (e.g. `not_found`, `invalid_request`).",
      type: "string",
    },
    message: { description: "A human-readable description of the fault.", type: "string" },
    ok: { const: false, description: "Always `false` on a fault response.", type: "boolean" },
  },
  required: ["code", "message", "ok"],
  type: "object",
};

const ERROR_RESPONSE: ResponseValue = {
  content: { "application/json": { schema: { $ref: ERROR_SCHEMA_REF } } },
  description: "Fault — the `{ code, message, ok: false }` envelope, with the class in the status.",
};

/**
 * Register the shared `Error` component and attach it as the `default` response on
 * every operation in the generated doc — without disturbing the per-op success
 * responses, the operationIds, or anything else the generator produced. The
 * generated paths are exactly the public surface (the admin tier is already
 * filtered out before this runs), so every operation touched here is a public one.
 */
function attachDefaultErrorResponse(document: GeneratedDocument): GeneratedDocument {
  const components = document.components ?? {};
  document.components = {
    ...components,
    schemas: { ...components.schemas, [ERROR_SCHEMA_NAME]: ERROR_SCHEMA },
  };

  for (const pathItem of Object.values(document.paths ?? {})) {
    if (pathItem === undefined) {
      continue;
    }

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation === undefined) {
        continue;
      }

      // Never clobber a `default` the generator already emitted (it does not today,
      // but keep the per-op success responses untouched if that ever changes).
      operation.responses = { default: ERROR_RESPONSE, ...operation.responses };
    }
  }

  return document;
}

/** True when an oRPC contract procedure's REST path is under the admin tier. */
function isAdminPath(path: string | undefined): boolean {
  return path !== undefined && (path === "/admin" || path.startsWith(ADMIN_PATH_PREFIX));
}

/**
 * The PUBLIC OpenAPI 3.1 document, generated from the contract router with the
 * admin tier filtered out. Served at /api/v1/openapi.json (+ the /api alias) and
 * consumed by Scalar (/docs/api) and the Postman route. The richer `info`
 * (summary/description/contact) and the absolute server URL are carried over from
 * the retired static `public/openapi.json` so the published surface keeps its
 * prose.
 */
export async function generateOpenApiDocument() {
  const document = await generator.generate(router, {
    filter: ({ contract }) => !isAdminPath(contract["~orpc"].route.path),
    info: {
      contact: {
        name: "Fluncle",
        url: "https://www.fluncle.com",
      },
      description:
        "The public API for Fluncle's Findings, a drum & bass archive from another dimension. Fluncle discovers and certifies every track; each date marks when he found it, the day he first heard the tune, not the day it released. Read the archive, search Spotify candidates, and submit tracks for Fluncle to review.",
      summary: "Drum & bass bangers from another dimension.",
      title: "Fluncle API",
      version: "1.0.0",
    },
    servers: [{ url: "https://www.fluncle.com/api/v1" }],
  });

  // Document the uniform fault envelope every public op can return, as a shared
  // component attached as each op's `default` response (the success responses the
  // generator emitted are left untouched).
  return attachDefaultErrorResponse(document);
}
