import { oc } from "@orpc/contract";
import * as z from "zod";

export const UserStatusSchema = z
  .enum(["active", "suspended", "deleted"])
  .meta({ id: "UserStatus" });

export const UserAdminItemSchema = z
  .object({
    createdAt: z.string(),
    displayUsername: z.string().nullable(),
    email: z.string(),
    emailVerified: z.boolean(),
    hasGalaxyProgress: z.boolean(),
    id: z.string(),
    image: z.string().nullable(),
    lastSeenAt: z.string().nullable(),
    name: z.string(),
    savedFindingCount: z.number(),
    savedSetCount: z.number(),
    status: UserStatusSchema,
    username: z.string().nullable(),
  })
  .meta({ id: "UserAdminItem" });

export const listUsersAdmin = oc
  .route({
    method: "GET",
    operationId: "listUsersAdmin",
    path: "/admin/users",
    summary: "Every user account with its verified/status flags and artifact counts",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(z.object({ ok: z.literal(true), users: z.array(UserAdminItemSchema) }));

export const adminUsersContract = {
  list_users_admin: listUsersAdmin,
};
