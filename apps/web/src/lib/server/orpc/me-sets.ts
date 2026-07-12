// The `me-sets` domain router module — the saved-`/mix`-sets slice of the `/me`
// private-user tier. The list read is on `privateUserAuth` (401 without a session);
// save/update/delete are on a `privateUserMutation` (CSRF + the live per-op rate
// limit). Every handler is a thin wrapper over the `account-data` helper, which owns
// the SQL and the owner-scoping. The `me-saved` sibling is the precedent.

import { ORPCError } from "@orpc/server";
import { deleteSavedSet, listSavedSets, saveSet, updateSavedSet } from "../account-data";
import { privateUserAuth, privateUserMutation } from "../orpc-auth";
import { apiFault, type Implementer, responseFault } from "./_shared";

/**
 * Build the `me-sets` domain's handlers.
 *
 *   - `list_private_saved_sets` — `GET /me/saved-sets`. Reuses `listSavedSets`;
 *     returns the `{ ok: true, savedSets }` envelope.
 *   - `save_private_set` — `POST /me/saved-sets`. CSRF + the `account.sets.write`/90
 *     rate limit; reuses `saveSet` (→ Response on `invalid_request`/`empty_set`, else
 *     the saved-set echo).
 *   - `update_private_saved_set` — `PATCH /me/saved-sets/{id}`. CSRF + the
 *     `account.sets.update`/90 rate limit; reuses `updateSavedSet` (owner-scoped →
 *     404 on another user's id).
 *   - `delete_private_saved_set` — `DELETE /me/saved-sets/{id}`. CSRF + the
 *     `account.sets.delete`/90 rate limit; reuses `deleteSavedSet` (owner-scoped).
 */
export function meSetsHandlers(os: Implementer) {
  const listSets = os.list_private_saved_sets.use(privateUserAuth).handler(async ({ context }) => {
    try {
      return await listSavedSets(context.user);
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  const saveSetHandler = os.save_private_set
    .use(privateUserMutation({ action: "account.sets.write", limit: 90 }))
    .handler(async ({ context, input }) => {
      try {
        const result = await saveSet(context.user, input);

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

  const updateSet = os.update_private_saved_set
    .use(privateUserMutation({ action: "account.sets.update", limit: 90 }))
    .handler(async ({ context, input }) => {
      try {
        const result = await updateSavedSet(context.user, input.id, input);

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

  const deleteSet = os.delete_private_saved_set
    .use(privateUserMutation({ action: "account.sets.delete", limit: 90 }))
    .handler(async ({ context, input }) => {
      try {
        const result = await deleteSavedSet(context.user, input.id);

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
    delete_private_saved_set: deleteSet,
    list_private_saved_sets: listSets,
    save_private_set: saveSetHandler,
    update_private_saved_set: updateSet,
  };
}
