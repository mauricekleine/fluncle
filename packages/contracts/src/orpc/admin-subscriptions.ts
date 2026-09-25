import { oc } from "@orpc/contract";
import * as z from "zod";
import { SubscriptionDTOSchema } from "./_shared";

const SubscriptionEnvelope = z.object({
  ok: z.literal(true),
  subscription: SubscriptionDTOSchema,
});

export const listSubscriptions = oc
  .route({
    method: "GET",
    operationId: "listSubscriptions",
    path: "/admin/subscriptions",
    summary: "List the operator's cost ledger (every subscription + one-off line)",
    tags: ["Admin"],
  })
  .output(z.object({ ok: z.literal(true), subscriptions: z.array(SubscriptionDTOSchema) }));

export const createSubscription = oc
  .route({
    method: "POST",
    operationId: "createSubscription",
    path: "/admin/subscriptions",
    summary: "Add a cost line to the ledger",
    tags: ["Admin"],
  })
  .input(z.looseObject({}))
  .output(SubscriptionEnvelope);

export const updateSubscription = oc
  .route({
    method: "PATCH",
    operationId: "updateSubscription",
    path: "/admin/subscriptions/{id}",
    summary: "Update a cost line's fields",
    tags: ["Admin"],
  })
  .input(z.looseObject({ id: z.string() }))
  .output(SubscriptionEnvelope);

export const deleteSubscription = oc
  .route({
    method: "DELETE",
    operationId: "deleteSubscription",
    path: "/admin/subscriptions/{id}",
    summary: "Delete a cost line",
    tags: ["Admin"],
  })
  .input(z.object({ id: z.string() }))
  .output(z.object({ id: z.string(), ok: z.literal(true) }));

export const adminSubscriptionsContract = {
  create_subscription: createSubscription,
  delete_subscription: deleteSubscription,
  list_subscriptions: listSubscriptions,
  update_subscription: updateSubscription,
};
