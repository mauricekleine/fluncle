import { ORPCError } from "@orpc/server";
import { deleteFollow, listFollows, saveFollow } from "../account-data";
import { privateUserAuth, privateUserMutation } from "../orpc-auth";
import { apiFault, type Implementer, responseFault } from "./_shared";

export function meFollowsHandlers(os: Implementer) {
  const listFollowsHandler = os.list_private_follows
    .use(privateUserAuth)
    .handler(async ({ context }) => {
      try {
        return await listFollows(context.user);
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  const saveFollowHandler = os.save_private_follow
    .use(privateUserMutation({ action: "account.follows.write", limit: 90 }))
    .handler(async ({ context, input }) => {
      try {
        const result = await saveFollow(context.user, input);

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

  const deleteFollowHandler = os.delete_private_follow
    .use(privateUserMutation({ action: "account.follows.delete", limit: 90 }))
    .handler(async ({ context, input }) => {
      try {
        const result = await deleteFollow(context.user, input.id);

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
    delete_private_follow: deleteFollowHandler,
    list_private_follows: listFollowsHandler,
    save_private_follow: saveFollowHandler,
  };
}
