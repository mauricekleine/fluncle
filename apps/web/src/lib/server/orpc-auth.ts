import { ORPCError, os } from "@orpc/server";
import { requireAccountMutation } from "./account-data";
import { type AdminRole, adminRole, requireAdminMutationOrigin } from "./env";
import { type PublicUser, requirePublicUser } from "./public-auth";

import { type OrpcContext } from "./orpc-context";

export type AdminContext = OrpcContext & {
  role: AdminRole;
};

export const base = os.$context<OrpcContext>();

export const adminAuth = base.middleware(async ({ context, next }) => {
  const role = await adminRole(context.request);

  if (!role) {
    throw new ORPCError("UNAUTHORIZED", { message: "Missing or invalid admin token" });
  }

  const crossOrigin = requireAdminMutationOrigin(context.request);

  if (crossOrigin) {
    await liftResponseToFault(crossOrigin);
  }

  return next({ context: { role } });
});

export const adminProcedure = base.use(adminAuth);

export const operatorGuard = os.$context<AdminContext>().middleware(({ context, next }) => {
  if (context.role !== "operator") {
    throw new ORPCError("FORBIDDEN", { message: "This action requires the operator role" });
  }

  return next();
});

export const operatorProcedure = adminProcedure.use(operatorGuard);

async function liftResponseToFault(response: Response): Promise<never> {
  const { responseFault } = await import("./orpc/_shared");

  throw await responseFault(response);
}

export const privateUserAuth = base.middleware(async ({ context, next }) => {
  const user = await requirePublicUser(context.request);

  if (user instanceof Response) {
    await liftResponseToFault(user);
  }

  return next({ context: { user: user as PublicUser } });
});

export const privateUserProcedure = base.use(privateUserAuth);

export function privateUserMutation(options: { action: string; limit: number; windowMs?: number }) {
  return base.middleware(async ({ context, next }) => {
    const user = await requireAccountMutation(context.request, options);

    if (user instanceof Response) {
      await liftResponseToFault(user);
    }

    return next({ context: { user: user as PublicUser } });
  });
}
