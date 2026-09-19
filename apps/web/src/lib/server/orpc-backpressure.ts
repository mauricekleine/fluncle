// THE ONE PLACE BACKPRESSURE IS ANSWERED.
//
// A bounded due-work maintenance pass that has not finished converging throws
// `DueWorkMaintenancePendingError` — a typed "come back", not a fault. Handlers that catch and
// convert already agree (`./orpc/_shared` `apiFault`), but a handler with no catch, a middleware, an
// input validator, or a helper that throws past a narrower catch would otherwise reach the rails as
// an unexpected throw: a captured Sentry error and a 500 on a read whose only honest answer is that
// it is deferred.
//
// It lives in its own module, apart from the router it is applied to, because the consumers that
// must RECOGNISE it — the CORS matcher's "carries no middleware, therefore unauthenticated" proxy
// and the auth-tier coverage guard — are imported by that router and cannot import back from it.
// Both compare by this reference, so an unrecognised middleware still fails their guards loudly.

import { contract } from "@fluncle/contracts/orpc";
import { implement } from "@orpc/server";
import { isDueWorkMaintenancePending } from "./due-work";
import { type OrpcContext } from "./orpc-auth";
import { dueWorkMaintenancePendingFault } from "./orpc/_shared";

export const dueWorkMaintenancePendingMiddleware = implement(contract)
  .$context<OrpcContext>()
  .middleware(async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      if (isDueWorkMaintenancePending(error)) {
        throw dueWorkMaintenancePendingFault();
      }

      throw error;
    }
  });

/**
 * The router-level middleware that carries no authority. Every op inherits it, so it says nothing
 * about an op's auth tier and nothing about whether an op is a public unauthenticated read.
 */
export const NON_AUTH_ROUTER_MIDDLEWARES: readonly unknown[] = [
  dueWorkMaintenancePendingMiddleware,
];

/** An op's middleware chain with the authority-free router middleware removed. */
export function authMiddlewaresOf(middlewares: readonly unknown[]): unknown[] {
  return middlewares.filter((middleware) => !NON_AUTH_ROUTER_MIDDLEWARES.includes(middleware));
}
