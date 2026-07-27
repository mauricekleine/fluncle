// The TanStack Start instance (the `#tanstack-start-entry`, resolved by convention
// from `src/start.ts`). Its one job here is to register a GLOBAL function middleware
// that redacts server-function faults before the framework serializes them to the
// browser.
//
// WHY A GLOBAL FUNCTION MIDDLEWARE IS THE CHOKEPOINT: a global `functionMiddleware`
// runs on EVERY server function, wrapping the whole handler chain, in BOTH transports
// that put a fault on the wire — the SSR in-process call (whose thrown error becomes
// the dehydrated `match.error`) and the client-navigation HTTP call (whose thrown
// error is seroval-encoded in the server-fn response). And because every route
// fetches its data through a `createServerFn` (AGENTS.md), a driver/upstream fault
// originates INSIDE a server-fn handler — so sanitizing here covers the loader path
// too. See `lib/server/serverfn-fault.ts` for the policy and the incident it closes.
//
// CSRF: with no start instance, `createStartHandler` applies a default CSRF request
// middleware to server functions. Declaring a start instance REPLACES that default
// with whatever `requestMiddleware` we set — so we MUST re-declare the same CSRF
// middleware here, or same-origin CSRF protection would be silently dropped. This is
// the exact middleware the framework's default installs.

import { isNotFound, isRedirect } from "@tanstack/react-router";
import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

// Global function middleware: wrap every server function's execution and redact any
// UNEXPECTED fault before it can be serialized to the client. Control-flow signals
// (redirect / not-found) are re-thrown untouched on the fast path — they must reach
// the client to drive navigation, and keeping them out of the redactor avoids a
// dynamic import on the common auth-gate path. A real fault is handed to the
// server-only redactor (dynamic import keeps the `lib/server/**` chain out of any
// client chunk — docs/client-bundle.md), which logs + captures the full detail and
// returns the wire-safe error (the raw message for a verified admin principal, a
// generic one for everyone else).
const serverFnFaultRedaction = createMiddleware({ type: "function" }).server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (isRedirect(error) || isNotFound(error)) {
      throw error;
    }

    let request: Request | undefined;

    try {
      request = getRequest();
    } catch {
      request = undefined;
    }

    const { redactServerFnFault } = await import("./lib/server/serverfn-fault");

    throw await redactServerFnFault(error, request);
  }
});

// The framework default: same-origin CSRF protection on server functions. Re-declared
// so declaring this start instance does not drop it (see the header note).
const csrfMiddleware = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });

export const startInstance = createStart(() => ({
  functionMiddleware: [serverFnFaultRedaction],
  requestMiddleware: [csrfMiddleware],
}));
