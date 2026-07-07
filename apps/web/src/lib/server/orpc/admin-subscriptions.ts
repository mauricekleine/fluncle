// The `admin-subscriptions` domain router module — the operator's private cost
// ledger (COST-02). Each handler wraps the `subscriptions` server helper; the auth
// tier lives in the oRPC procedure middleware (../orpc-auth).
//
// Auth tiers (never a public or agent caller — the ledger is the operator's alone):
//   - `list_subscriptions` — admin tier (`adminAuth`): the ledger read.
//   - `create_subscription` / `update_subscription` / `delete_subscription` — operator
//     tier (`adminAuth` + `operatorGuard`): the writes. A valid agent token gets a 403.
//
// LOOSE bodies — the `subscriptions` module validates each field + throws its own
// `ApiError` codes, so the contract stays permissive and `apiFault` carries the code.

import {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  updateSubscription,
} from "../subscriptions";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

/** Build the `admin-subscriptions` domain's handlers. */
export function adminSubscriptionsHandlers(os: Implementer) {
  // GET /admin/subscriptions — admin tier. The whole cost ledger.
  const listSubscriptionsHandler = os.list_subscriptions.use(adminAuth).handler(async () => {
    try {
      return { ok: true as const, subscriptions: await listSubscriptions() };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // POST /admin/subscriptions — OPERATOR tier. Add a cost line.
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

  // PATCH /admin/subscriptions/{id} — OPERATOR tier. Edit a cost line.
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

  // DELETE /admin/subscriptions/{id} — OPERATOR tier. Remove a cost line.
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
