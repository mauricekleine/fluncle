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
