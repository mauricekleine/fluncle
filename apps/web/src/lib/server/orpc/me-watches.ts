import { ORPCError } from "@orpc/server";
import { deleteWatch, listWatches, saveWatch } from "../account-data";
import { privateUserAuth, privateUserMutation } from "../orpc-auth";
import { apiFault, type Implementer, responseFault } from "./_shared";

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
