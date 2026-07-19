// The `me-watches` domain router module — the watched-entities slice of the `/me`
// private-user tier. The list read is on `privateUserAuth` (401 without a session);
// watch/unwatch are on a `privateUserMutation` (CSRF + the live per-op rate limit). Every
// handler is a thin wrapper over the `account-data` helper, which owns the SQL and the
// owner-scoping. The `me-sets` sibling is the precedent.

import { ORPCError } from "@orpc/server";
import { deleteWatch, listWatches, saveWatch } from "../account-data";
import { privateUserAuth, privateUserMutation } from "../orpc-auth";
import { apiFault, type Implementer, responseFault } from "./_shared";

/**
 * Build the `me-watches` domain's handlers.
 *
 *   - `list_private_watches` — `GET /me/watches`. Reuses `listWatches`; returns the
 *     `{ ok: true, watches }` envelope.
 *   - `save_private_watch` — `POST /me/watches`. CSRF + the `account.watches.write`/90
 *     rate limit; reuses `saveWatch` (→ Response on `invalid_request`/`entity_not_found`,
 *     else the watch echo).
 *   - `delete_private_watch` — `DELETE /me/watches/{id}`. CSRF + the
 *     `account.watches.delete`/90 rate limit; reuses `deleteWatch` (owner-scoped → 404 on
 *     another user's id).
 */
export function meWatchesHandlers(os: Implementer) {
  const listWatchesHandler = os.list_private_watches
    .use(privateUserAuth)
    .handler(async ({ context }) => {
      try {
        return await listWatches(context.user);
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  const saveWatchHandler = os.save_private_watch
    .use(privateUserMutation({ action: "account.watches.write", limit: 90 }))
    .handler(async ({ context, input }) => {
      try {
        const result = await saveWatch(context.user, input);

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

  const deleteWatchHandler = os.delete_private_watch
    .use(privateUserMutation({ action: "account.watches.delete", limit: 90 }))
    .handler(async ({ context, input }) => {
      try {
        const result = await deleteWatch(context.user, input.id);

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
    delete_private_watch: deleteWatchHandler,
    list_private_watches: listWatchesHandler,
    save_private_watch: saveWatchHandler,
  };
}
