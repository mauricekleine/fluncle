import { ORPCError } from "@orpc/server";
import {
  deleteDigestFollow,
  isFollowDigestPaused,
  listDigestFollows,
  sendFollowDigests,
  setFollowDigestPaused,
  setFollowDigestSubscription,
} from "../follow-digest";
import { verifyFollowDigestToken, type FollowDigestPurpose } from "../follow-digest-tokens";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { assertRateLimit } from "../rate-limit";
import { type Implementer, toFault } from "./_shared";

function signedUser(
  token: string | undefined,
  ...purposes: [FollowDigestPurpose, ...FollowDigestPurpose[]]
): string {
  const userId = token
    ? (purposes.map((purpose) => verifyFollowDigestToken(token, purpose)).find(Boolean) ?? null)
    : null;
  if (!userId) {
    throw new ORPCError("UNAUTHORIZED", { message: "Invalid follow digest link" });
  }
  return userId;
}

async function limitMutation(request: Request, userId: string): Promise<void> {
  await assertRateLimit({
    action: "follow_digest_mutation",
    limit: 20,
    request,
    userId,
    windowMs: 60 * 60 * 1000,
  });
}

export function followDigestHandlers(os: Implementer) {
  const sendFollowDigestsHandler = os.send_follow_digests
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return await sendFollowDigests(input);
      } catch (error) {
        throw toFault(error);
      }
    });

  const getFollowDigestStateHandler = os.get_follow_digest_state
    .use(adminAuth)
    .handler(async () => {
      try {
        return { ok: true as const, paused: await isFollowDigestPaused() };
      } catch (error) {
        throw toFault(error);
      }
    });

  const setFollowDigestStateHandler = os.set_follow_digest_state
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        await setFollowDigestPaused(input.paused);
        return { ok: true as const, paused: input.paused };
      } catch (error) {
        throw toFault(error);
      }
    });

  const unsubscribeFollowDigestHandler = os.unsubscribe_follow_digest.handler(
    async ({ context, input }) => {
      try {
        const userId = signedUser(input.query.token ?? input.body?.token, "unsubscribe", "manage");
        await limitMutation(context.request, userId);
        await setFollowDigestSubscription(userId, false);
        return { ok: true as const, subscribed: false as const };
      } catch (error) {
        throw toFault(error);
      }
    },
  );

  const subscribeFollowDigestHandler = os.subscribe_follow_digest.handler(
    async ({ context, input }) => {
      try {
        const userId = signedUser(input.query.token ?? input.body?.token, "manage");
        await limitMutation(context.request, userId);
        await setFollowDigestSubscription(userId, true);
        return { ok: true as const, subscribed: true as const };
      } catch (error) {
        throw toFault(error);
      }
    },
  );

  const listDigestFollowsHandler = os.list_digest_follows.handler(async ({ input }) => {
    try {
      return await listDigestFollows(signedUser(input.token, "manage"));
    } catch (error) {
      throw toFault(error);
    }
  });

  const deleteDigestFollowHandler = os.delete_digest_follow.handler(async ({ context, input }) => {
    try {
      const userId = signedUser(input.query.token, "manage");
      await limitMutation(context.request, userId);
      if (!(await deleteDigestFollow(userId, input.params.id))) {
        throw new ORPCError("NOT_FOUND", { message: "Follow not found" });
      }
      return { ok: true as const };
    } catch (error) {
      throw toFault(error);
    }
  });

  return {
    delete_digest_follow: deleteDigestFollowHandler,
    get_follow_digest_state: getFollowDigestStateHandler,
    list_digest_follows: listDigestFollowsHandler,
    send_follow_digests: sendFollowDigestsHandler,
    set_follow_digest_state: setFollowDigestStateHandler,
    subscribe_follow_digest: subscribeFollowDigestHandler,
    unsubscribe_follow_digest: unsubscribeFollowDigestHandler,
  };
}
