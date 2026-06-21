// The admin auth spine for the oRPC migration — the shared middleware tier every
// admin contract builds on (docs/orpc-migration-brief.md, "The admin auth
// middleware"). It is a direct port of the role model in ./env.ts into oRPC
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
import { type AdminRole, adminRole } from "./env";

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
// for reads, enrich-sweep, analysis write-back, and the conditional routes that
// then branch on `context.role` in-handler.
export const adminProcedure = base.use(adminAuth);

// `operatorProcedure` — operator only. A valid `agent` token gets a 403 (it
// authenticated fine, it just lacks the role); a non-admin a 401 (from
// `adminAuth`, which runs first). Use on every publish-/irreversible-class op.
// ORPCError("FORBIDDEN") maps to HTTP 403.
export const operatorProcedure = adminProcedure.use(({ context, next }) => {
  if (context.role !== "operator") {
    throw new ORPCError("FORBIDDEN", { message: "This action requires the operator role" });
  }

  return next();
});
