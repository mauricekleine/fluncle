import { ORPCError } from "@orpc/server";
import { deleteFollow, listFollows, saveFollow } from "../account-data";
import { createFollowDigestToken, revokeFollowDigestManageLinks } from "../follow-digest-tokens";
import { privateUserAuth, privateUserMutation } from "../orpc-auth";
import { type PublicUser } from "../public-auth";
import { apiFault, type Implementer, responseFault } from "./_shared";

export function meFollowsHandlers(os: Implementer) {
  const listForUser = async (user: PublicUser) => {
    try {
      return await listFollows(user);
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  };

  const saveForUser = async (user: PublicUser, input: unknown) => {
    try {
      const result = await saveFollow(user, input);

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
  };

  const deleteForUser = async (user: PublicUser, id: string) => {
    try {
      const result = await deleteFollow(user, id);

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
  };

  const listFollowsHandler = os.list_private_follows
    .use(privateUserAuth)
    .handler(async ({ context }) => listForUser(context.user));

  const listWatchesHandler = os.list_private_watches
    .use(privateUserAuth)
    .handler(async ({ context }) => {
      const result = await listForUser(context.user);
      return { ok: result.ok, watches: result.follows };
    });

  const saveFollowHandler = os.save_private_follow
    .use(privateUserMutation({ action: "account.follows.write", limit: 90 }))
    .handler(async ({ context, input }) => saveForUser(context.user, input));

  const saveWatchHandler = os.save_private_watch
    .use(privateUserMutation({ action: "account.follows.write", limit: 90 }))
    .handler(async ({ context, input }) => {
      const result = await saveForUser(context.user, input);
      const { createdAt, entityId, id, includeSimilar, kind } = result.follow;
      return { ok: result.ok, watch: { createdAt, entityId, id, includeSimilar, kind } };
    });

  const deleteFollowHandler = os.delete_private_follow
    .use(privateUserMutation({ action: "account.follows.delete", limit: 90 }))
    .handler(async ({ context, input }) => deleteForUser(context.user, input.id));

  const deleteWatchHandler = os.delete_private_watch
    .use(privateUserMutation({ action: "account.follows.delete", limit: 90 }))
    .handler(async ({ context, input }) => deleteForUser(context.user, input.id));

  const revokeFollowLinksHandler = os.revoke_private_follow_link_access
    .use(privateUserMutation({ action: "account.follows.revoke_links", limit: 20 }))
    .handler(async ({ context }) => {
      try {
        await revokeFollowDigestManageLinks(context.user.id);
        return {
          ok: true as const,
          token: await createFollowDigestToken(context.user.id, "manage"),
        };
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }
        throw apiFault(error);
      }
    });

  return {
    delete_private_follow: deleteFollowHandler,
    delete_private_watch: deleteWatchHandler,
    list_private_follows: listFollowsHandler,
    list_private_watches: listWatchesHandler,
    revoke_private_follow_link_access: revokeFollowLinksHandler,
    save_private_follow: saveFollowHandler,
    save_private_watch: saveWatchHandler,
  };
}
