// The `admin-subscriptions` domain contract module — the operator's PRIVATE cost
// ledger (COST-02): the single source of truth for Fluncle's recurring + one-off
// spend. Built on the `admin-editions` CRUD pattern. Everything nests under
// `/admin/subscriptions`, and the whole surface is admin-gated (never public).
//
// This ledger was pulled out of the public repo docs on purpose — vendor names and
// amounts are the operator's private data, so they live in the DB at runtime, behind
// this admin surface, never in a committed file. There is no agent use for it, so the
// tiers are deliberately tight:
//   - `list_subscriptions` — admin tier (`adminAuth`): the ledger read.
//   - `create_subscription` / `update_subscription` / `delete_subscription` — operator
//     tier (`adminAuth` + `operatorGuard`): the writes are the operator's alone.
//
// Mutating bodies stay LOOSE/passthrough — the server `subscriptions` module validates
// each field and throws its own codes, so the contract must not pre-reject.

import { oc } from "@orpc/contract";
import * as z from "zod";
import { SubscriptionDTOSchema } from "./_shared";

/** The `{ ok, subscription }` envelope the single-row writes return. */
const SubscriptionEnvelope = z.object({
  ok: z.literal(true),
  subscription: SubscriptionDTOSchema,
});

/**
 * `list_subscriptions` → `GET /admin/subscriptions` (operationId `listSubscriptions`).
 *
 * Admin tier. The whole cost ledger, newest-updated first. Preserves
 * `{ ok, subscriptions }`.
 */
export const listSubscriptions = oc
  .route({
    method: "GET",
    operationId: "listSubscriptions",
    path: "/admin/subscriptions",
    summary: "List the operator's cost ledger (every subscription + one-off line)",
    tags: ["Admin"],
  })
  .output(z.object({ ok: z.literal(true), subscriptions: z.array(SubscriptionDTOSchema) }));

/**
 * `create_subscription` → `POST /admin/subscriptions` (operationId `createSubscription`).
 *
 * Operator tier. Add one cost line. LOOSE body — `createSubscription` validates the
 * required fields + the closed category/cadence/status sets. Preserves
 * `{ ok, subscription }`.
 */
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

/**
 * `update_subscription` → `PATCH /admin/subscriptions/{id}` (operationId
 * `updateSubscription`).
 *
 * Operator tier. Edit a cost line's fields. LOOSE body — `updateSubscription`
 * validates. Preserves `{ ok, subscription }`.
 */
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

/**
 * `delete_subscription` → `DELETE /admin/subscriptions/{id}` (operationId
 * `deleteSubscription`).
 *
 * Operator tier. Remove a cost line from the ledger. Returns the deleted id in
 * `{ id, ok }`.
 */
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

/** The `admin-subscriptions` domain's ops, merged into the root contract by `./index.ts`. */
export const adminSubscriptionsContract = {
  create_subscription: createSubscription,
  delete_subscription: deleteSubscription,
  list_subscriptions: listSubscriptions,
  update_subscription: updateSubscription,
};
