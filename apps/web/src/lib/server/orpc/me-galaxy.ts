// The `me-galaxy` domain router module — the Galaxy-progress slice of the `/me`
// private-user tier. Implements the three ops off the shared implementer the root
// (../orpc.ts) hands in, each lifted onto the private-user auth tier
// (../orpc-auth): the read on `privateUserAuth` (401 without a session), the
// writes on a `privateUserMutation` (CSRF + the live per-op rate limit). Every
// handler reuses the live route's logic verbatim, re-expressing only I/O + framing.

import { ORPCError } from "@orpc/server";
import { collectLogId, getGalaxyProgress, mergeGalaxyProgress } from "../account-data";
import { privateUserAuth, privateUserMutation } from "../orpc-auth";
import { apiFault, type Implementer, responseFault } from "./_shared";

// The live POST /me/galaxy-progress/logs route's own 400 for a non-string logId
// (jsonError(400, "invalid_request", "Missing Log ID")), reproduced as the
// matching ORPCError so the rails encoder emits the identical body.
async function missingLogIdFault(): Promise<ORPCError<string, unknown>> {
  return responseFault(
    Response.json(
      { code: "invalid_request", message: "Missing Log ID", ok: false },
      { status: 400 },
    ),
  );
}

/**
 * Build the `me-galaxy` domain's handlers.
 *
 *   - `get_private_galaxy_progress` — port of GET /me/galaxy-progress. Auth via
 *     `privateUserAuth` (the live `requirePublicUser` 401); reuses
 *     `getGalaxyProgress` and returns its object verbatim.
 *   - `merge_private_galaxy_progress` — port of PUT /me/galaxy-progress. CSRF +
 *     the live `account.galaxy.merge`/30 rate limit; reuses `mergeGalaxyProgress`,
 *     which returns either a `jsonError` Response (→ `responseFault`) or the merged
 *     progress.
 *   - `collect_private_galaxy_log` — port of POST /me/galaxy-progress/logs. CSRF +
 *     the live `account.galaxy.log`/120 rate limit; ports the live in-handler
 *     `typeof logId !== "string"` 400 (`invalid_request`) check, then reuses
 *     `collectLogId` (→ Response on `log_not_found`, else `{ logId, ok: true }`).
 *
 * Each catch re-throws a deliberate `ORPCError` (auth/CSRF/business faults) as-is
 * so the rails encoder keeps its exact code/status; only an unexpected fault is
 * wrapped by `apiFault` into the legacy 500.
 */
export function meGalaxyHandlers(os: Implementer) {
  const getProgress = os.get_private_galaxy_progress
    .use(privateUserAuth)
    .handler(async ({ context }) => {
      try {
        return await getGalaxyProgress(context.user);
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  const mergeProgress = os.merge_private_galaxy_progress
    .use(privateUserMutation({ action: "account.galaxy.merge", limit: 30 }))
    .handler(async ({ context, input }) => {
      try {
        const result = await mergeGalaxyProgress(context.user, input);

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

  const collectLog = os.collect_private_galaxy_log
    .use(privateUserMutation({ action: "account.galaxy.log", limit: 120 }))
    .handler(async ({ context, input }) => {
      try {
        if (typeof input.logId !== "string") {
          throw await missingLogIdFault();
        }

        const result = await collectLogId(context.user, input.logId);

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
    collect_private_galaxy_log: collectLog,
    get_private_galaxy_progress: getProgress,
    merge_private_galaxy_progress: mergeProgress,
  };
}
