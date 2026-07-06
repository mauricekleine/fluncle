// Shared rails helpers for the oRPC router modules. The per-domain handler files
// (`./tracks.ts`, `./health.ts`, …) import the fault converter + the implementer
// type from here so each domain's catch can produce a wire-compatible error the
// root encoder (../orpc.ts) reshapes into the legacy `jsonError` body.

import { contract } from "@fluncle/contracts/orpc";
import { type implement, ORPCError } from "@orpc/server";
import { type OrpcContext } from "../orpc-auth";
import { type TrackListItem, getTrackByIdOrLogId } from "../tracks";
import { ApiError } from "../spotify";

/**
 * The contract implementer type the domain handler factories receive. The root
 * (../orpc.ts) builds the single `implement(contract).$context<OrpcContext>()`
 * and hands it to each `*Handlers(os)` factory, so every domain implements off
 * one builder and one shared context.
 */
export type Implementer = ReturnType<typeof implement<typeof contract, OrpcContext>>;

// The tolerant `limit`/`dryRun` query coercion the live routes used. One definition
// in `../query-params`; re-exported here so the oRPC handlers keep importing their
// rails helpers from `./_shared`.
export { parseBool, parseLimit } from "../query-params";

/**
 * Fetch a track by id or Log ID, or throw the canonical NOT_FOUND fault. The single
 * source of the `not_found` / "No track with id …" 404 that the admin track/social
 * handlers raised inline; the wire body (apiCode/apiMessage/status) is preserved
 * byte-for-byte (the contract-coverage tests pin it).
 */
export async function requireTrack(idOrLogId: string): Promise<TrackListItem> {
  const track = await getTrackByIdOrLogId(idOrLogId);

  if (!track) {
    throw new ORPCError("NOT_FOUND", {
      data: { apiCode: "not_found", apiMessage: `No track with id ${idOrLogId}` },
      message: `No track with id ${idOrLogId}`,
      status: 404,
    });
  }

  return track;
}

// ── Error wire-shape parity (the fault converter half) ───────────────────────
// The HTTP body re-encoding lives at the rails (../orpc.ts `encodeErrorBody`);
// this is the conversion every handler's catch uses to turn an unexpected fault
// (or a custom-coded one) into an `ORPCError` carrying the legacy `{ code,
// message }` so the encoder reproduces the exact `jsonError` body.

/**
 * The API `code`/`message` an `ORPCError` carries through to the wire when the
 * thrown oRPC code can't say them on its own. A converted `ApiError`, a generic
 * 500, or a custom-coded read (e.g. the random-track 404's `track_not_found`)
 * stash their legacy `{ code, message }` here so the rails encoder reproduces
 * the exact `jsonError` body, not a lossy mapping.
 */
export type ApiFaultData = { apiCode: string; apiMessage: string };

export function isApiFaultData(data: unknown): data is ApiFaultData {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as ApiFaultData).apiCode === "string" &&
    typeof (data as ApiFaultData).apiMessage === "string"
  );
}

/**
 * Convert an unexpected (non-`ORPCError`) fault into an `ORPCError` whose status,
 * code, and message match the legacy `apiErrorResponse` (http-errors.ts): an
 * `ApiError` keeps its own status/code/message; anything else is a 500 with code
 * `error`. The legacy `{ code, message }` ride along in `data` so the rails
 * encoder reproduces the exact `jsonError` body. Shared so every converted
 * handler's catch can `throw apiFault(error)` for one wire-compatible 500 path.
 */
export function apiFault(error: unknown): ORPCError<string, ApiFaultData> {
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
 * The canonical catch wrapper every admin handler uses: an `ORPCError` (a guard
 * the procedure or a field check threw) passes through untouched so its status /
 * code / message survive; anything else (an `ApiError` from a reused helper, or
 * an unexpected throw) becomes a wire-compatible fault via `apiFault`, so the
 * rails encoder reproduces the legacy `{ code, message }` body.
 */
export function toFault(error: unknown): ORPCError<string, unknown> {
  if (error instanceof ORPCError) {
    return error;
  }

  return apiFault(error);
}

// ── Response → fault parity (the `/me` private tier) ─────────────────────────
// The live `/me` route helpers (account-data.ts, public-auth.ts) signal failure
// by RETURNING a `jsonError` `Response` (body `{ code, message, ok: false }`,
// status on the Response), not by throwing — the auth/CSRF/rate-limit guards
// (401/403/415/429) and the per-op business 4xx (404/409/…) both take this form.
// `responseFault` re-expresses one of those Responses as an `ORPCError` carrying
// the SAME `{ code, message }` in `ApiFaultData` at the SAME status, so the rails
// encoder reproduces the legacy body byte-for-byte. The `/me` handlers (and the
// private-user middleware in ../orpc-auth) throw this whenever a reused live
// helper hands back a `Response`, so every guard/business failure stays exact.

/**
 * Convert a `jsonError`-shaped `Response` (the failure carrier of the live `/me`
 * helpers) into an `ORPCError` that reproduces its `{ code, message }` body at
 * its status. The body is read from a clone (the live Response is built in
 * memory, never streamed); a non-JSON or shapeless body degrades to a generic
 * fault at the Response's status so an unexpected helper Response can't crash the
 * rails.
 */
export async function responseFault(response: Response): Promise<ORPCError<string, ApiFaultData>> {
  let apiCode = "error";
  let apiMessage = response.statusText || "Request failed";

  try {
    const body = (await response.clone().json()) as { code?: unknown; message?: unknown };

    if (typeof body.code === "string") {
      apiCode = body.code;
    }

    if (typeof body.message === "string") {
      apiMessage = body.message;
    }
  } catch {
    // A non-JSON body keeps the status-derived defaults above.
  }

  return new ORPCError("INTERNAL_SERVER_ERROR", {
    data: { apiCode, apiMessage },
    message: apiMessage,
    status: response.status,
  });
}
