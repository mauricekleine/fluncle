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
//     and Sentry, and the wire gets a generic message — EXCEPT on `/admin`, which is
//     operator-only, where the detailed message is diagnostics (the 2026-07-26
//     incident proved its worth).

import * as Sentry from "@sentry/cloudflare";
import { logEvent } from "./log";
import { ApiError } from "./spotify";

/**
 * The message that crosses the wire for a redacted (public) fault. It is never
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
 * is returned ONLY for an `/admin` request (operator diagnostics) — every other
 * surface gets a fresh generic `Error`, so no driver/upstream internals reach an
 * unauthenticated caller.
 *
 * `request` is the ambient server-fn request (from `getRequest()` in start.ts),
 * passed in so this stays a pure, unit-testable function; `undefined` (no request
 * context) is treated as public — the safe default.
 */
export function redactServerFnFault(error: unknown, request: Request | undefined): unknown {
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
  const path = pagePathForFault(request);

  logEvent("error", "serverfn.unexpected-fault", { error, path });
  Sentry.captureException(error, { tags: { source: "serverfn.redaction" } });

  // /admin is operator-only, behind admin auth: the detailed message there is
  // diagnostics, not a leak. Everywhere else the wire gets a generic message.
  if (path?.startsWith("/admin") ?? false) {
    return error;
  }

  return new Error(GENERIC_SERVERFN_FAULT_MESSAGE);
}

/**
 * The page path this fault belongs to, or `undefined` when it cannot be determined.
 *
 * Two transports, two sources:
 *   - SSR runs the server fn IN-PROCESS, so `getRequest()` is the page request
 *     itself (`/admin/reach`, `/log/<id>`, …) — read its pathname.
 *   - A client navigation calls the server fn over HTTP at its own endpoint
 *     (`/_serverFn/...`), which carries no page path. The framework's client fetcher
 *     stamps `x-tsr-serverFn: true` on that request, and the browser stamps the
 *     originating page in the same-origin `Referer` (the app's
 *     `Referrer-Policy: strict-origin-when-cross-origin` sends the full path
 *     same-origin) — read the Referer's pathname.
 *
 * Keying off the `x-tsr-serverFn` header (not the URL) means the Referer is consulted
 * ONLY for a genuine HTTP server-fn call, so an operator navigating from `/admin` to
 * a public page (whose SSR request carries an `/admin` Referer) never leaks detail on
 * that public page.
 */
function pagePathForFault(request: Request | undefined): string | undefined {
  if (!request) {
    return undefined;
  }

  try {
    if (request.headers.get("x-tsr-serverFn") === "true") {
      const referer = request.headers.get("referer");

      return referer ? new URL(referer).pathname : undefined;
    }

    return new URL(request.url).pathname;
  } catch {
    return undefined;
  }
}
