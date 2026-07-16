// The `admin-users` domain router module — the user-account roster's admin surface.
// One op, on the `admin-labels` read pattern:
//
//   - `list_users_admin` — `adminAuth` (agent-allowed read): every account with its
//     verified/status flags and its per-user artifact counts.
//
// READ-ONLY by design: there is no write here. Account status transitions live behind
// Better Auth + the user's own `/me` tier, never an operator mutation. See
// packages/contracts/src/orpc/admin-users.ts.

import { adminAuth } from "../orpc-auth";
import { listAdminUsers } from "../users";
import { apiFault, type Implementer } from "./_shared";

/** Build the `admin-users` domain's handlers. */
export function adminUsersHandlers(os: Implementer) {
  // GET /admin/users — `adminAuth` (operator OR agent): the newest-first roster with
  // each account's derived artifact counts.
  const listUsersAdminHandler = os.list_users_admin.use(adminAuth).handler(async () => {
    try {
      return { ok: true as const, users: await listAdminUsers() };
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    list_users_admin: listUsersAdminHandler,
  };
}
