// Shared rails helpers for the oRPC router modules. The per-domain handler files
// (`./tracks.ts`, `./health.ts`, …) import the fault converter + the implementer
// type from here so each domain's catch can produce a wire-compatible error the
// root encoder (../orpc.ts) reshapes into the legacy `jsonError` body.

import { contract } from "@fluncle/contracts/orpc";
import { type implement, ORPCError } from "@orpc/server";
import { type OrpcContext } from "../orpc-auth";
import { ApiError } from "../spotify";

/**
 * The contract implementer type the domain handler factories receive. The root
 * (../orpc.ts) builds the single `implement(contract).$context<OrpcContext>()`
 * and hands it to each `*Handlers(os)` factory, so every domain implements off
 * one builder and one shared context.
 */
export type Implementer = ReturnType<typeof implement<typeof contract, OrpcContext>>;

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
