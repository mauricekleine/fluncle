import {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  updateSubscription,
} from "../subscriptions";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

export function adminSubscriptionsHandlers(os: Implementer) {
  const listSubscriptionsHandler = os.list_subscriptions.use(adminAuth).handler(async () => {
    try {
      return { ok: true as const, subscriptions: await listSubscriptions() };
    } catch (error) {
      throw apiFault(error);
    }
  });

  const createSubscriptionHandler = os.create_subscription
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return { ok: true as const, subscription: await createSubscription(input) };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const updateSubscriptionHandler = os.update_subscription
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { id, ...body } = input;
        const subscription = await updateSubscription(id, body);

        return { ok: true as const, subscription };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const deleteSubscriptionHandler = os.delete_subscription
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { id } = await deleteSubscription(input.id);

        return { id, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    create_subscription: createSubscriptionHandler,
    delete_subscription: deleteSubscriptionHandler,
    list_subscriptions: listSubscriptionsHandler,
    update_subscription: updateSubscriptionHandler,
  };
}
