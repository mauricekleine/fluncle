// The `me-recs` domain router module — the per-user recommendation engine's
// slice of the `/me` private-user tier (docs/the-ear.md § The per-user
// telescopes). The seed list is on `privateUserAuth` (401 without a session);
// save/delete are on `privateUserMutation` (CSRF + per-op rate limit); the
// recommendations read is on `privateUserAuth` PLUS its own in-handler hourly
// rate limit (a GET, but each request is a real vector scan) and the
// verified-email gate the engine itself enforces (403 `email_unverified`).

import { ORPCError } from "@orpc/server";
import { privateUserAuth, privateUserMutation } from "../orpc-auth";
import { enforceRateLimit } from "../rate-limit";
import {
  deleteRecSeed,
  listRecommendations,
  listRecSeeds,
  RECOMMENDATIONS_RATE_LIMIT,
  RECOMMENDATIONS_RATE_WINDOW_MS,
  saveRecSeed,
} from "../recommendations";
import { apiFault, type Implementer, responseFault } from "./_shared";

/**
 * Build the `me-recs` domain's handlers.
 *
 *   - `list_private_rec_seeds` — the seed list, hydrated (title/artists/cover).
 *   - `save_private_rec_seed` — add a seed (by trackId or Log ID); CSRF + the
 *     `account.recs.write`/90 rate limit; 409 `seed_limit` past the 12-seed cap.
 *   - `delete_private_rec_seed` — remove a seed; CSRF + `account.recs.delete`/90.
 *   - `list_private_recommendations` — THE ENGINE (the LIVE vector scan). Session +
 *     verified email (the helper's 403), and a modest per-user hourly limit applied
 *     here (`account.recs.read`/RECOMMENDATIONS_RATE_LIMIT), because a scan that runs
 *     costs the database ≤12 probes × the embedded catalogue. The web `/recommendations`
 *     shelf no longer reads through this op on the hot path — it reads a stored edition
 *     (frontier-shelf-from-editions-rfc.md), so a committed page view runs NO scan. The
 *     scan survives here for the DRAFT phase and for non-web clients (mobile/MCP/CLI)
 *     that read recommendations directly; the same `account.recs.read` budget also guards
 *     the web draft path (the route's `readDraftRecommendations`), so both entrances share
 *     one honest limit.
 */
export function meRecsHandlers(os: Implementer) {
  const listSeeds = os.list_private_rec_seeds.use(privateUserAuth).handler(async ({ context }) => {
    try {
      return await listRecSeeds(context.user);
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  const saveSeed = os.save_private_rec_seed
    .use(privateUserMutation({ action: "account.recs.write", limit: 90 }))
    .handler(async ({ context, input }) => {
      try {
        const result = await saveRecSeed(context.user, input);

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

  const deleteSeed = os.delete_private_rec_seed
    .use(privateUserMutation({ action: "account.recs.delete", limit: 90 }))
    .handler(async ({ context, input }) => {
      try {
        const result = await deleteRecSeed(context.user, input.trackId);

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

  const listRecs = os.list_private_recommendations
    .use(privateUserAuth)
    .handler(async ({ context }) => {
      try {
        // The hourly per-user budget, ahead of any database work. A GET carries
        // no CSRF preamble, so the limit is applied here rather than through
        // `privateUserMutation`.
        const limited = await enforceRateLimit({
          action: "account.recs.read",
          limit: RECOMMENDATIONS_RATE_LIMIT,
          request: context.request,
          userId: context.user.id,
          windowMs: RECOMMENDATIONS_RATE_WINDOW_MS,
        });

        if (limited) {
          throw await responseFault(limited);
        }

        const result = await listRecommendations(context.user);

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
    delete_private_rec_seed: deleteSeed,
    list_private_rec_seeds: listSeeds,
    list_private_recommendations: listRecs,
    save_private_rec_seed: saveSeed,
  };
}
