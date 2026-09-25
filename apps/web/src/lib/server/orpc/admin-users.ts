import { adminAuth } from "../orpc-auth";
import { listAdminUsers } from "../users";
import { apiFault, type Implementer } from "./_shared";

export function adminUsersHandlers(os: Implementer) {
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
