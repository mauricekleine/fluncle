import { oc } from "@orpc/contract";
import * as z from "zod";

const TokenSchema = z.string().min(10).max(1024);

export const sendFollowDigests = oc
  .route({
    method: "POST",
    operationId: "sendFollowDigests",
    path: "/admin/follow-digests/send",
    summary: "Send the weekly digest to eligible followers in a bounded batch",
    tags: ["Admin"],
  })
  .input(
    z.object({
      cursor: z.string().optional(),
      dryRun: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
  )
  .output(
    z.object({
      capped: z.boolean(),
      considered: z.number(),
      dryRun: z.boolean(),
      empty: z.number(),
      failed: z.number(),
      nextCursor: z.string().optional(),
      ok: z.literal(true),
      paused: z.boolean(),
      sent: z.number(),
      skipped: z.number(),
      unknown: z.number(),
      weekKey: z.string(),
    }),
  );

export const getFollowDigestState = oc
  .route({
    method: "GET",
    operationId: "getFollowDigestState",
    path: "/admin/follow-digests/state",
    summary: "Read the follow digest kill switch",
    tags: ["Admin"],
  })
  .output(z.object({ ok: z.literal(true), paused: z.boolean() }));

export const setFollowDigestState = oc
  .route({
    method: "PUT",
    operationId: "setFollowDigestState",
    path: "/admin/follow-digests/state",
    summary: "Pause or resume weekly follow digests",
    tags: ["Admin"],
  })
  .input(z.object({ paused: z.boolean() }))
  .output(z.object({ ok: z.literal(true), paused: z.boolean() }));

export const unsubscribeFollowDigest = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "unsubscribeFollowDigest",
    path: "/follow-digest/unsubscribe",
    summary: "Unsubscribe a signed follow digest recipient",
    tags: ["Follow digest"],
  })
  .input(
    z.object({
      body: z
        .object({
          "List-Unsubscribe": z.literal("One-Click").optional(),
          token: TokenSchema.optional(),
        })
        .optional(),
      query: z.object({ token: TokenSchema.optional() }),
    }),
  )
  .output(z.object({ ok: z.literal(true), subscribed: z.literal(false) }));

export const subscribeFollowDigest = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "subscribeFollowDigest",
    path: "/follow-digest/subscribe",
    summary: "Subscribe a signed follow digest recipient",
    tags: ["Follow digest"],
  })
  .input(
    z.object({
      body: z.object({ token: TokenSchema.optional() }).optional(),
      query: z.object({ token: TokenSchema.optional() }),
    }),
  )
  .output(z.object({ ok: z.literal(true), subscribed: z.literal(true) }));

export const listDigestFollows = oc
  .route({
    method: "GET",
    operationId: "listDigestFollows",
    path: "/follow-digest/follows",
    summary: "List follows for a signed digest recipient",
    tags: ["Follow digest"],
  })
  .input(z.object({ token: TokenSchema }))
  .output(
    z.object({
      follows: z.array(
        z.object({
          id: z.string(),
          kind: z.enum(["artist", "label"]),
          name: z.string(),
          slug: z.string(),
        }),
      ),
      ok: z.literal(true),
      subscribed: z.boolean(),
    }),
  );

export const deleteDigestFollow = oc
  .route({
    inputStructure: "detailed",
    method: "DELETE",
    operationId: "deleteDigestFollow",
    path: "/follow-digest/follows/{id}",
    summary: "Remove one follow for a signed digest recipient",
    tags: ["Follow digest"],
  })
  .input(
    z.object({
      params: z.object({ id: z.string().min(1) }),
      query: z.object({ token: TokenSchema }),
    }),
  )
  .output(z.object({ ok: z.literal(true) }));

export const followDigestContract = {
  delete_digest_follow: deleteDigestFollow,
  get_follow_digest_state: getFollowDigestState,
  list_digest_follows: listDigestFollows,
  send_follow_digests: sendFollowDigests,
  set_follow_digest_state: setFollowDigestState,
  subscribe_follow_digest: subscribeFollowDigest,
  unsubscribe_follow_digest: unsubscribeFollowDigest,
};
