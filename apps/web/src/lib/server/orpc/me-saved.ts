// The `me-saved` domain router module — the saved-findings slice of the `/me`
// private-user tier. The list read is on `privateUserAuth` (401 without a
// session); save/unsave are on a `privateUserMutation` (CSRF + the live per-op
// rate limit). Every handler reuses the live route's logic verbatim.

import { ORPCError } from "@orpc/server";
import { deleteSavedFinding, listSavedFindings, saveFinding } from "../account-data";
import { privateUserAuth, privateUserMutation } from "../orpc-auth";
import { apiFault, type Implementer, responseFault } from "./_shared";

/**
 * Build the `me-saved` domain's handlers.
 *
 *   - `list_private_saved_findings` — port of GET /me/saved-findings. Reuses
 *     `listSavedFindings`; returns the `{ ok: true, savedFindings }` envelope.
 *   - `save_private_finding` — port of POST /me/saved-findings. CSRF + the live
 *     `account.saved.write`/90 rate limit; reuses `saveFinding` (→ Response on
 *     `invalid_request`/`track_not_found`, else the saved-finding echo).
 *   - `unsave_private_finding` — port of DELETE /me/saved-findings/{trackId}. CSRF
 *     + the live `account.saved.delete`/90 rate limit; reuses `deleteSavedFinding`
 *     (→ Response on `track_not_found`, else bare `{ ok: true }`).
 */
export function meSavedHandlers(os: Implementer) {
  const listSaved = os.list_private_saved_findings
    .use(privateUserAuth)
    .handler(async ({ context }) => {
      try {
        return await listSavedFindings(context.user);
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  const saveFindingHandler = os.save_private_finding
    .use(privateUserMutation({ action: "account.saved.write", limit: 90 }))
    .handler(async ({ context, input }) => {
      try {
        const result = await saveFinding(context.user, input);

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

  const unsaveFinding = os.unsave_private_finding
    .use(privateUserMutation({ action: "account.saved.delete", limit: 90 }))
    .handler(async ({ context, input }) => {
      try {
        const result = await deleteSavedFinding(context.user, input.trackId);

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
    list_private_saved_findings: listSaved,
    save_private_finding: saveFindingHandler,
    unsave_private_finding: unsaveFinding,
  };
}
