import { AnchorCandidateSchema, contract } from "@fluncle/contracts/orpc";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { implement, ORPCError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { type OrpcContext } from "./orpc-context";
import { applyPublicCors, buildPublicCorsMatcher, corsPreflightResponse } from "./orpc-cors";
import { dueWorkMaintenancePendingMiddleware } from "./orpc-backpressure";
import { isApiFaultData } from "./orpc/_shared";
import { logEvent } from "./log";
import { adminAlbumsHandlers } from "./orpc/admin-albums";
import { adminArtifactsHandlers } from "./orpc/admin-artifacts";
import { adminArtistRulesHandlers } from "./orpc/admin-artist-rules";
import { adminArtistsHandlers } from "./orpc/admin-artists";
import { adminAttentionHandlers } from "./orpc/admin-attention";
import { adminBackfillsHandlers } from "./orpc/admin-backfills";
import { adminBiosHandlers } from "./orpc/admin-bios";
import { adminCatalogueHandlers } from "./orpc/admin-catalogue";
import { adminCostsHandlers } from "./orpc/admin-costs";
import { adminDatabaseAdmissionHandlers } from "./orpc/admin-database-admission";
import { adminGalaxiesHandlers } from "./orpc/admin-galaxies";
import { adminPromptsHandlers } from "./orpc/admin-prompts";
import { adminProjectionHandlers } from "./orpc/admin-projections";
import { adminVectorHandlers } from "./orpc/admin-vectors";
import { adminReachHandlers } from "./orpc/admin-reach";
import { albumsHandlers } from "./orpc/albums";
import { artistsHandlers } from "./orpc/artists";
import { galaxiesHandlers } from "./orpc/galaxies";
import { graphHandlers } from "./orpc/graph";
import { labelsHandlers } from "./orpc/labels";
import { adminEditionsHandlers } from "./orpc/admin-editions";
import { adminFrontierHandlers } from "./orpc/admin-frontier";
import { adminFunnelHandlers } from "./orpc/admin-funnel";
import { adminHealthHandlers } from "./orpc/admin-health";
import { adminHubCountsHandlers } from "./orpc/admin-hub-counts";
import { adminLabelsHandlers } from "./orpc/admin-labels";
import { adminLogbookHandlers } from "./orpc/admin-logbook";
import { adminMigrationsHandlers } from "./orpc/admin-migrations";
import { adminMixtapesHandlers } from "./orpc/admin-mixtapes";
import { adminNotesHandlers } from "./orpc/admin-notes";
import { adminObservationsHandlers } from "./orpc/admin-observations";
import { adminOperationReceiptHandlers } from "./orpc/admin-operation-receipts";
import { adminRecordingsHandlers } from "./orpc/admin-recordings";
import { adminSocialHandlers } from "./orpc/admin-social";
import { adminSubmissionsHandlers } from "./orpc/admin-submissions";
import { adminSubscriptionsHandlers } from "./orpc/admin-subscriptions";
import { adminTelemetryHandlers } from "./orpc/admin-telemetry";
import { adminTokensHandlers } from "./orpc/admin-tokens";
import { adminTracksHandlers } from "./orpc/admin-tracks";
import { adminTwitchHandlers } from "./orpc/admin-twitch";
import { adminUsersHandlers } from "./orpc/admin-users";
import { devicesHandlers } from "./orpc/devices";
import { editionsHandlers } from "./orpc/editions";
import { followDigestHandlers } from "./orpc/follow-digest";
import { healthHandlers } from "./orpc/health";
import { meHandlers } from "./orpc/me";
import { meFrontierHandlers } from "./orpc/me-frontier";
import { meGalaxyHandlers } from "./orpc/me-galaxy";
import { mePreferencesHandlers } from "./orpc/me-preferences";
import { meRecsHandlers } from "./orpc/me-recs";
import { meSavedHandlers } from "./orpc/me-saved";
import { meSetsHandlers } from "./orpc/me-sets";
import { meFollowsHandlers } from "./orpc/me-follows";
import { mixHandlers } from "./orpc/mix";
import { mixtapesHandlers } from "./orpc/mixtapes";
import { newsletterHandlers } from "./orpc/newsletter";
import { radioHandlers } from "./orpc/radio";
import { reachHandlers } from "./orpc/reach";
import { replicaHandlers } from "./orpc/replica";
import { searchHandlers } from "./orpc/search";
import { storiesHandlers } from "./orpc/stories";
import { submissionsHandlers } from "./orpc/submissions";
import { tracksHandlers } from "./orpc/tracks";

const os = implement(contract).$context<OrpcContext>();

export const router = os.use(dueWorkMaintenancePendingMiddleware).router({
  ...adminAlbumsHandlers(os),
  ...adminArtifactsHandlers(os),
  ...adminArtistRulesHandlers(os),
  ...adminArtistsHandlers(os),
  ...adminAttentionHandlers(os),
  ...adminBackfillsHandlers(os),
  ...adminBiosHandlers(os),
  ...adminCatalogueHandlers(os),
  ...adminCostsHandlers(os),
  ...adminDatabaseAdmissionHandlers(os),
  ...adminGalaxiesHandlers(os),
  ...adminPromptsHandlers(os),
  ...adminProjectionHandlers(os),
  ...adminVectorHandlers(os),
  ...adminReachHandlers(os),
  ...albumsHandlers(os),
  ...artistsHandlers(os),
  ...galaxiesHandlers(os),
  ...graphHandlers(os),
  ...labelsHandlers(os),
  ...adminEditionsHandlers(os),
  ...adminFrontierHandlers(os),
  ...adminFunnelHandlers(os),
  ...adminHealthHandlers(os),
  ...adminHubCountsHandlers(os),
  ...followDigestHandlers(os),
  ...adminLabelsHandlers(os),
  ...adminLogbookHandlers(os),
  ...adminMigrationsHandlers(os),
  ...adminMixtapesHandlers(os),
  ...adminNotesHandlers(os),
  ...adminObservationsHandlers(os),
  ...adminOperationReceiptHandlers(os),
  ...adminRecordingsHandlers(os),
  ...adminSocialHandlers(os),
  ...adminSubmissionsHandlers(os),
  ...adminSubscriptionsHandlers(os),
  ...adminTelemetryHandlers(os),
  ...adminTokensHandlers(os),
  ...adminTracksHandlers(os),
  ...adminTwitchHandlers(os),
  ...adminUsersHandlers(os),
  ...devicesHandlers(os),
  ...editionsHandlers(os),
  ...healthHandlers(os),
  ...meHandlers(os),
  ...meFrontierHandlers(os),
  ...meGalaxyHandlers(os),
  ...mePreferencesHandlers(os),
  ...meRecsHandlers(os),
  ...meSavedHandlers(os),
  ...meSetsHandlers(os),
  ...meFollowsHandlers(os),
  ...mixHandlers(os),
  ...mixtapesHandlers(os),
  ...newsletterHandlers(os),
  ...radioHandlers(os),
  ...reachHandlers(os),
  ...replicaHandlers(os),
  ...searchHandlers(os),
  ...storiesHandlers(os),
  ...submissionsHandlers(os),
  ...tracksHandlers(os),
});

export type Router = typeof router;

const ORPC_CODE_TO_API_CODE: Record<string, string> = {
  BAD_REQUEST: "invalid_request",

  INTERNAL_SERVER_ERROR: "error",

  NOT_FOUND: "not_found",
};

function orpcCodeToApiCode(code: string): string {
  return ORPC_CODE_TO_API_CODE[code] ?? code.toLowerCase();
}

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

const handler = new OpenAPIHandler(router, {
  customErrorResponseBodyEncoder: encodeErrorBody,
});

const API_PREFIX = "/api/v1";

const NO_STORE_SUFFIXES = new Set([
  "/admin/vectors/tracks/serving",
  "/follow-digest/follows",
  "/health",
  "/replica/token",
]);
const NO_STORE_SUFFIX_PATTERNS = [/^\/admin\/tracks\/[^/]+\/capture\/(?:prepare|authorize)$/];

function isNoStoreSuffix(suffix: string): boolean {
  return (
    NO_STORE_SUFFIXES.has(suffix) ||
    NO_STORE_SUFFIX_PATTERNS.some((pattern) => pattern.test(suffix))
  );
}

export const isPublicCorsPath = buildPublicCorsMatcher(
  router as unknown as Record<string, unknown>,
);

export async function handleOrpc(request: Request): Promise<Response | null> {
  const url = new URL(request.url);

  if (!url.pathname.startsWith(`${API_PREFIX}/`)) {
    return null;
  }

  const suffix = url.pathname.slice(API_PREFIX.length);
  const anchorValidationRequest =
    suffix === "/admin/catalogue/anchor" && request.method === "POST" ? request.clone() : null;

  const preflight = corsPreflightResponse(request, suffix, isPublicCorsPath);

  if (preflight) {
    return preflight;
  }

  const { matched, response } = await handler.handle(request, {
    context: { request },
    prefix: API_PREFIX,
  });

  if (!matched) {
    return null;
  }

  if (anchorValidationRequest && response.status === 400) {
    try {
      const input: unknown = await anchorValidationRequest.json();
      const candidates =
        typeof input === "object" && input !== null && "candidates" in input
          ? input.candidates
          : undefined;
      const fields = new Set<string>();
      if (Array.isArray(candidates)) {
        if (candidates.length > 100) {
          fields.add("candidates");
        }
        for (const candidate of candidates.slice(0, 100)) {
          const parsed = AnchorCandidateSchema.safeParse(candidate);
          if (!parsed.success) {
            for (const issue of parsed.error.issues) {
              fields.add(`candidates.${issue.path.map(String).join(".")}`);
            }
          }
        }
      } else {
        fields.add("candidates");
      }
      if (
        typeof input !== "object" ||
        input === null ||
        !("trackId" in input) ||
        typeof input.trackId !== "string" ||
        input.trackId.length === 0
      ) {
        fields.add("trackId");
      }
      logEvent("warn", "anchor.validation-failed", { fields: [...fields].sort() });
    } catch {
      logEvent("warn", "anchor.validation-failed", { fields: ["body"] });
    }
  }

  if (isNoStoreSuffix(suffix)) {
    response.headers.set("Cache-Control", "no-store");
  }

  applyPublicCors(request, suffix, response, isPublicCorsPath);

  return response;
}

const generator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter()],
});

const ADMIN_PATH_PREFIX = "/admin/";

const ERROR_SCHEMA_NAME = "Error";
const ERROR_SCHEMA_REF = `#/components/schemas/${ERROR_SCHEMA_NAME}`;

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

type GeneratedDocument = Awaited<ReturnType<typeof generator.generate>>;
type SchemaValue = NonNullable<NonNullable<GeneratedDocument["components"]>["schemas"]>[string];
type PathItem = NonNullable<GeneratedDocument["paths"]>[string];
type Operation = NonNullable<NonNullable<PathItem>["get"]>;
type ResponseValue = NonNullable<Operation["responses"]>[string];

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
  description: "Fault: the `{ code, message, ok: false }` envelope, with the class in the status.",
};

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

      operation.responses = { default: ERROR_RESPONSE, ...operation.responses };
    }
  }

  return document;
}

function isAdminPath(path: string | undefined): boolean {
  return path !== undefined && (path === "/admin" || path.startsWith(ADMIN_PATH_PREFIX));
}

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

  return attachDefaultErrorResponse(document);
}
