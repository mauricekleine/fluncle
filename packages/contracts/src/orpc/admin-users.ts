// The `admin-users` domain contract module — the site's user-account roster, the
// operator's READ-ONLY window on the gated rollout of the account-backed features
// (saved findings, saved sets, the Galaxy). One op, on the `admin-labels` /
// `admin-galaxies` pattern (an agent-allowed full read; there is no write in this
// slice — the account lifecycle is owned by Better Auth + the `/me` private tier,
// never by an operator mutation here):
//
//   - `list_users_admin` — admin tier (agent-allowed read): every account with its
//     verified/status flags and its per-user artifact counts. Named `_admin` (the
//     `list_labels_admin` / `list_galaxies_admin` precedent) so the bare `list_users`
//     name stays free for any future public surface.
//
// ── READ-ONLY, AND DELIBERATELY SO ─────────────────────────────────────────────
// This station only WATCHES the roster grow. It mints nothing, suspends nothing,
// deletes nothing: account status transitions (suspend, the deletion that
// ANONYMIZES the row) live behind Better Auth and the user's own `/me` tier, not an
// admin write. Adding a mutation here is a deliberate future act, not an omission.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * A user account's lifecycle status (mirrors the `user.status` column). `deleted`
 * is a row whose PII was ANONYMIZED in place (the deletion flow blanks the identity
 * columns rather than dropping the row), so a deleted account still counts here.
 */
export const UserStatusSchema = z
  .enum(["active", "suspended", "deleted"])
  .meta({ id: "UserStatus" });

/**
 * One account in the admin roster shape. `id` is the identity. `username` /
 * `displayUsername` / `image` are null until the user sets them. `emailVerified` is
 * the account's verified state. The three counts are DERIVED (correlated COUNTs over
 * the per-user artifact tables, never stored): `savedFindingCount` (saved findings),
 * `savedSetCount` (saved `/mix` sets), and `hasGalaxyProgress` (whether a
 * `user_galaxy_state` row exists at all — the cheap "has this account played" bit,
 * not a score). `createdAt` is the join date; `lastSeenAt` is null until the account
 * is seen once. Both are ISO strings.
 */
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

/**
 * `list_users_admin` → `GET /admin/users` (operationId `listUsersAdmin`).
 *
 * Admin tier (agent-allowed read, the `list_labels_admin` precedent). Every account
 * the site knows, newest-first, each with its verified/status flags and its per-user
 * artifact counts. A pure read; it publishes nothing and mutates nothing. `{ ok,
 * users }`.
 */
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

/** The `admin-users` domain's ops, merged into the root contract by `./index.ts`. */
export const adminUsersContract = {
  list_users_admin: listUsersAdmin,
};
