// Wire redaction for TanStack Start server-function faults — the loader/server-fn
// counterpart to the oRPC fault path (lib/server/orpc/_shared.ts `apiFault`).
//
// THE LEAK IT CLOSES: every public route fetches its data through a
// `createServerFn` handler that the route's `loader` calls (AGENTS.md), and a fault
// thrown in that handler is serialized to the browser BY THE FRAMEWORK — the SSR
// dehydration path (`dehydrateMatch` seroval-encodes `match.error`) and the
// client-navigation transport (`server-functions-handler` seroval-encodes the
// caught error) both put the raw `Error.message` on the wire. A driver fault
// (`SQLITE input error: no such column: t.video_structure`) therefore reached a
// public browser console verbatim. oRPC already keeps its unexpected faults off the
// wire (a generic 500, full detail to the log + Sentry); server functions did not.
//
// This module is that discipline for the server-fn path. It is invoked from the
// GLOBAL function middleware in `src/start.ts` (which runs on every server function,
// SSR and client-nav alike), reached by a dynamic import so this `lib/server/**`
// chain never lands in a client chunk (docs/client-bundle.md).
//
// THE POLICY (mirrors apiFault):
//   - A deliberate typed error (`ApiError`) is a client contract — echo it.
//     Redirects / not-founds are handled upstream in start.ts (control flow, never
//     reaches here).
//   - Anything else is an UNEXPECTED fault: the full detail goes to the server log
//     and Sentry, and the wire gets a generic message — EXCEPT for a request that
//     carries a VERIFIED admin principal, where the detailed message is operator
//     diagnostics (the 2026-07-26 incident proved its worth).
//
// WHY VERIFIED IDENTITY, NOT THE PAGE PATH: an earlier draft granted detail when the
// request "looked" admin (an `/admin` URL or Referer). Both are attacker-settable on
// a direct call to a public server-fn endpoint, so that reopened the very leak this
// closes — spoof two headers, receive driver internals. The gate is now `adminRole`,
// the same non-spoofable primitive `requireAdmin` reads (a signed grant cookie or a
// constant-time-checked Bearer token). A browser on `/admin` sends its grant cookie
// on both the SSR page request and the same-origin server-fn fetch, so the operator
// keeps full detail; nobody without a valid credential does.

import * as Sentry from "@sentry/cloudflare";
import { adminRole } from "./env";
import { logEvent } from "./log";
import { ApiError } from "./spotify";

/**
 * The message that crosses the wire for a redacted (non-admin) fault. It is never
 * rendered — the root `errorComponent` shows its own in-voice "Rough re-entry" copy —
 * but it is what a serialized `Error` carries, so it says nothing about the fault.
 * Matches the oRPC `apiFault` 500 body for one consistent generic string.
 */
export const GENERIC_SERVERFN_FAULT_MESSAGE = "Internal error";

/**
 * Reduce a caught server-function fault to what may cross the wire.
 *
 * A deliberate `ApiError` is returned untouched (its message is a client contract,
 * exactly as the oRPC path echoes an `ApiError`). Anything else is an unexpected
 * fault: it is logged and captured server-side with full detail, then the raw error
 * is returned ONLY when the request carries a verified admin principal (operator
 * diagnostics) — every other caller gets a fresh generic `Error`, so no
 * driver/upstream internals reach an unauthenticated caller.
 *
 * `request` is the ambient server-fn request (from `getRequest()` in start.ts),
 * passed in so identity is resolved from the real credential; `undefined` (no request
 * context) is treated as non-admin — the safe default.
 */
export async function redactServerFnFault(
  error: unknown,
  request: Request | undefined,
): Promise<unknown> {
  // A deliberate typed error is a client contract — its message is safe to echo,
  // exactly as the oRPC fault path echoes an ApiError.
  if (error instanceof ApiError) {
    return error;
  }

  // An unexpected fault: the raw detail (driver / upstream internals) belongs in the
  // private diagnostics channel, never on the wire. Mirrors apiFault's
  // `api.unexpected-fault` — one filterable log event + one Sentry group.
  //
  // NOTE ON DOUBLE-CAPTURE: `server.ts`'s `withSentry` only captures throws that
  // escape the Worker fetch; this fault is CAUGHT by the middleware (it is turned
  // into a wire value, never rethrown out of the Worker), so `withSentry` never sees
  // it. This explicit capture is therefore the one and only server-side capture of
  // the real error — not a duplicate.
  logEvent("error", "serverfn.unexpected-fault", { error, path: requestPath(request) });
  Sentry.captureException(error, { tags: { source: "serverfn.redaction" } });

  // A verified admin principal (operator cookie or admin/agent Bearer token) gets the
  // detail — it is diagnostics for them, not a leak. Everyone else gets a generic
  // message.
  if (await isAdminPrincipal(request)) {
    return error;
  }

  return new Error(GENERIC_SERVERFN_FAULT_MESSAGE);
}

/**
 * Whether the request proves a verified admin identity, via the SAME primitive every
 * admin route reads (`adminRole` — a signed grant cookie or a constant-time-checked
 * Bearer token, never a header/path claim). Fails closed: no request, or any error
 * resolving the principal, reads as non-admin so the fault is redacted.
 */
async function isAdminPrincipal(request: Request | undefined): Promise<boolean> {
  if (!request) {
    return false;
  }

  try {
    return (await adminRole(request)) !== null;
  } catch {
    return false;
  }
}

/**
 * The request's own path, for the diagnostics log only (never the redaction
 * decision). During SSR this is the page (`/admin/reach`, `/log/<id>`); on a
 * client-navigation server-fn call it is the framework's `/_serverFn/...` endpoint.
 */
function requestPath(request: Request | undefined): string | undefined {
  if (!request) {
    return undefined;
  }

  try {
    return new URL(request.url).pathname;
  } catch {
    return undefined;
  }
}
