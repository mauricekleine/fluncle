import { contract } from "@fluncle/contracts/orpc";
import { implement } from "@orpc/server";
import { isDueWorkMaintenancePending } from "./due-work";
import { type OrpcContext } from "./orpc-context";
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

const NON_AUTH_ROUTER_MIDDLEWARES: readonly unknown[] = [dueWorkMaintenancePendingMiddleware];

export function authMiddlewaresOf(middlewares: readonly unknown[]): unknown[] {
  return middlewares.filter((middleware) => !NON_AUTH_ROUTER_MIDDLEWARES.includes(middleware));
}
