import { ORPCError } from "@orpc/server";
import {
  collectLogId,
  getGalaxyProgress,
  listGalaxyCollection,
  mergeGalaxyProgress,
} from "../account-data";
import { privateUserAuth, privateUserMutation } from "../orpc-auth";
import { apiFault, type Implementer, responseFault } from "./_shared";

async function missingLogIdFault(): Promise<ORPCError<string, unknown>> {
  return responseFault(
    Response.json(
      { code: "invalid_request", message: "Missing Log ID", ok: false },
      { status: 400 },
    ),
  );
}

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

  const listCollection = os.list_private_galaxy_collection
    .use(privateUserAuth)
    .handler(async ({ context }) => {
      try {
        return await listGalaxyCollection(context.user);
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
    list_private_galaxy_collection: listCollection,
    merge_private_galaxy_progress: mergeProgress,
  };
}
