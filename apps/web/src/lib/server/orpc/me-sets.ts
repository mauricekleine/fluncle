import { ORPCError } from "@orpc/server";
import { deleteSavedSet, listSavedSets, saveSet, updateSavedSet } from "../account-data";
import { privateUserAuth, privateUserMutation } from "../orpc-auth";
import { apiFault, type Implementer, responseFault } from "./_shared";

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
