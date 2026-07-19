// The admin auth spine for the oRPC migration — the shared middleware tier every
// admin contract builds on. It is a direct port of the role model in ./env.ts into oRPC
// middleware: no new auth semantics, just relocated so the per-handler
// `requireAdmin` / `requireOperator` boilerplate collapses to one typed context.
//
//   - `adminAuth`        resolves the principal once via `adminRole(request)` and
//                        injects a typed `context.role` for the handler to read.
//   - `adminProcedure`   = base.use(adminAuth) → 401 when the principal is null.
//                        Any admin principal (operator OR agent) passes. This is
//                        the oRPC equivalent of `requireAdmin`.
//   - `operatorProcedure`= adminProcedure + an operator-only guard → 403 for the
//                        `agent` role (it authenticated, it just lacks the role),
//                        401 for a non-admin. The equivalent of `requireOperator`.
//
// Field-level role checks (e.g. the agent may write only analysis fields) read
// `context.role` IN the handler, porting today's inline checks verbatim — the
// procedure tier draws the coarse line, the handler draws the fine one.
//
// The spine is built on the bare `os` builder (not `implement(contract)`) so it
// is op-agnostic: one `adminProcedure` / `operatorProcedure` reused across every
// admin op. A converted admin op is implemented on these procedures with
// `.route().input().output().handler()`, its contract op registered in the
// registry for the generated OpenAPI doc + coverage. The single request-carrying
// context is shared with the public ops (./orpc.ts), so one OpenAPIHandler serves
// both tiers off one injected `{ request }`.

import { ORPCError, os } from "@orpc/server";
import { requireAccountMutation } from "./account-data";
import { type AdminRole, adminRole } from "./env";
import { type PublicUser, requirePublicUser } from "./public-auth";

// The initial context every oRPC request is handled with. The Worker seam
// (./orpc.ts) passes the raw `Request` in; auth middleware derives `role` from
// it. Public procedures read neither; admin procedures `.use(adminAuth)` to lift
// `request` into a non-null `role`.
export type OrpcContext = {
  request: Request;
};

// The context an admin procedure's handler sees: the resolved role is guaranteed
// non-null past `adminAuth`.
export type AdminContext = OrpcContext & {
  role: AdminRole;
};

// The shared base, pinned to the request-carrying context. Public ops implement
// the contract off `implement(contract)` (./orpc.ts) with the same `$context`, so
// the one OpenAPIHandler can route both with a single injected context.
export const base = os.$context<OrpcContext>();

// `adminAuth` — resolve the principal once. Mirrors `requireAdmin`: a null
// principal is a 401; any admin principal (operator or agent) passes with its
// role lifted into the context. ORPCError("UNAUTHORIZED") maps to HTTP 401.
export const adminAuth = base.middleware(async ({ context, next }) => {
  const role = await adminRole(context.request);

  if (!role) {
    throw new ORPCError("UNAUTHORIZED", { message: "Missing or invalid admin token" });
  }

  return next({ context: { role } });
});

// `adminProcedure` — any authenticated admin (operator OR agent). Use as the base
// for reads, analysis write-back, and the conditional routes that then branch on
// `context.role` in-handler.
export const adminProcedure = base.use(adminAuth);

// `operatorGuard` — the operator-only check as a standalone MIDDLEWARE (the fine
// half of `operatorProcedure`). It assumes `adminAuth` has already run (so
// `context.role` is non-null): a valid `agent` token gets a 403 (it authenticated
// fine, it just lacks the role). A contract op implements the operator tier by
// applying BOTH — `os.<op>.use(adminAuth).use(operatorGuard)` — because a contract
// op `.use()`s middleware rather than building off `operatorProcedure` (which is a
// standalone procedure for `call()`/tests). ORPCError("FORBIDDEN") maps to HTTP 403.
export const operatorGuard = os.$context<AdminContext>().middleware(({ context, next }) => {
  if (context.role !== "operator") {
    throw new ORPCError("FORBIDDEN", { message: "This action requires the operator role" });
  }

  return next();
});

// `operatorProcedure` — operator only. A valid `agent` token gets a 403 (it
// authenticated fine, it just lacks the role); a non-admin a 401 (from
// `adminAuth`, which runs first). Use on every publish-/irreversible-class op.
// ORPCError("FORBIDDEN") maps to HTTP 403.
export const operatorProcedure = adminProcedure.use(operatorGuard);

// ── The private-user auth tier (the `/me` cookie-session spine) ───────────────
// The analogue of the admin spine above, for the OTHER identity: the logged-in
// public user resolved from the Spotify-login (better-auth) USER cookie — a
// DISTINCT carrier from the admin grant. It is a direct port of the live `/me`
// route preamble (account-data.ts / public-auth.ts) into oRPC middleware: no new
// auth semantics, just relocated so each `/me` op reads one typed `context.user`.
//
//   - `privateUserAuth`     the read-tier MIDDLEWARE: resolves the session via the
//                           SAME `requirePublicUser` the live reads call; a null
//                           session is the live 401 (`auth_required`, "Sign in to
//                           use this private account route") reproduced
//                           byte-for-byte. Injects `context.user`. A converted `/me`
//                           READ op applies it with `.use(privateUserAuth)` (GET /me/csrf,
//                           saved-findings list, galaxy progress, export-fetch, submissions).
//   - `privateUserProcedure`= base.use(privateUserAuth) → the same tier as a
//                           standalone PROCEDURE (the analogue of `adminProcedure`),
//                           for `call()`/tests and any non-contract use. The
//                           contract ops apply the middleware directly (a contract
//                           op is implemented off the shared implementer, so it
//                           `.use()`s the middleware rather than building off this).
//   - `privateUserMutation({action,limit,windowMs?})` → the CSRF-guarded write
//                           tier. A middleware FACTORY (per-op `action`/`limit`
//                           differ) that runs the SAME `requireAccountMutation`
//                           preamble the live mutating routes call — auth, the JSON
//                           mutation guard (content-type 415 / origin 403 / CSRF
//                           403), then the per-op rate limit (429) — in that exact
//                           order, and injects `context.user`. Applied BEFORE the
//                           contract's input validation so a 415/403 still wins over
//                           a malformed-body 400, exactly as the live route ordering.
//
// Both reuse the live helpers verbatim. Those helpers signal failure by RETURNING
// a `jsonError` `Response`; the middleware re-expresses that Response as the
// matching `ORPCError` via `responseFault` (./orpc/_shared) so the rails encoder
// reproduces the legacy `{ code, message, ok: false }` body at the same status.

// Lazy import to avoid a static cycle at module-eval time: orpc-auth is imported
// by ./orpc/_shared, which account-data's import chain transitively reaches.
async function liftResponseToFault(response: Response): Promise<never> {
  const { responseFault } = await import("./orpc/_shared");

  throw await responseFault(response);
}

// `privateUserAuth` — resolve the logged-in public user once. Mirrors the live
// read preamble (`requirePublicUser`): no session → the exact `auth_required`/401
// Response, lifted to the matching `ORPCError`; a valid session passes with the
// user lifted into the context.
export const privateUserAuth = base.middleware(async ({ context, next }) => {
  const user = await requirePublicUser(context.request);

  if (user instanceof Response) {
    await liftResponseToFault(user);
  }

  return next({ context: { user: user as PublicUser } });
});

// `privateUserProcedure` — a signed-in public user, no mutation guard. The base
// for every `/me` READ op.
export const privateUserProcedure = base.use(privateUserAuth);

/**
 * `privateUserMutation` — the CSRF-guarded write tier as a per-op middleware. The
 * live mutating `/me` routes each call `requireAccountMutation(request, { action,
 * limit, windowMs })`, which bundles auth → JSON mutation guard (content-type /
 * origin / CSRF) → rate limit and returns the user or a `jsonError` Response.
 * This wraps that exact call so a converted mutation gets identical 401/403/429
 * behavior and the same per-op rate-limit `action`/`limit`/`windowMs`, then
 * injects `context.user`. `windowMs` defaults to the live one-hour window (the
 * helper's own default); pass 24h for the delete/export daily windows.
 *
 * ONE DOCUMENTED DEVIATION — the content-type 415: the live route's
 * `requireJsonMutation` returns 415 `invalid_content_type` for a non-JSON body,
 * but oRPC's OpenAPIHandler decodes the request body to build the input BEFORE
 * this middleware runs, so a non-JSON body to a JSON-only `/me` mutation is
 * rejected one step earlier as a 400 `invalid_request` (the rails' BAD_REQUEST
 * mapping). Both reject the same bad request; only the code/status differ, and
 * the origin/CSRF security guards below are unaffected (they read headers, not
 * the body, so they fire here exactly as the live route does — see
 * orpc-wave-b-csrf.test.ts).
 */
export function privateUserMutation(options: { action: string; limit: number; windowMs?: number }) {
  return base.middleware(async ({ context, next }) => {
    const user = await requireAccountMutation(context.request, options);

    if (user instanceof Response) {
      await liftResponseToFault(user);
    }

    return next({ context: { user: user as PublicUser } });
  });
}
