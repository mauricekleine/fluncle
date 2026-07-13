// The `me-preferences` domain router module — a signed-in user's cross-device
// preferences slice of the `/me` private-user tier. The get is on `privateUserAuth`
// (401 without a session); the update is a `privateUserMutation` (CSRF + a per-op
// rate limit). Both handlers are thin wrappers over the `account-data` helpers,
// which own the SQL, the closed-schema validation, and the corrupt-blob tolerance.
// The `me-saved` / `me-sets` siblings are the precedent.

import { ORPCError } from "@orpc/server";
import { getUserPreferences, updateUserPreferences } from "../account-data";
import { privateUserAuth, privateUserMutation } from "../orpc-auth";
import { apiFault, type Implementer, responseFault } from "./_shared";

/**
 * Build the `me-preferences` domain's handlers.
 *
 *   - `get_my_preferences` — `GET /me/preferences`. Reuses `getUserPreferences`;
 *     returns the `{ ok: true, preferences }` envelope (an empty object when none
 *     set or the stored blob is unreadable — the read never throws).
 *   - `update_my_preferences` — `PATCH /me/preferences`. CSRF + the
 *     `account.preferences.update`/90 rate limit; reuses `updateUserPreferences`
 *     (partial merge into the stored object → the full merged echo, or a 400
 *     `invalid_request` Response on an unknown key).
 */
export function mePreferencesHandlers(os: Implementer) {
  const getPreferences = os.get_my_preferences.use(privateUserAuth).handler(async ({ context }) => {
    try {
      return await getUserPreferences(context.user);
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  const updatePreferences = os.update_my_preferences
    .use(privateUserMutation({ action: "account.preferences.update", limit: 90 }))
    .handler(async ({ context, input }) => {
      try {
        const result = await updateUserPreferences(context.user, input);

        if (result instanceof Response) {
          throw await responseFault(result);
        }

        return result;
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  return {
    get_my_preferences: getPreferences,
    update_my_preferences: updatePreferences,
  };
}
