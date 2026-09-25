import { oc } from "@orpc/contract";
import * as z from "zod";

export const FollowKindSchema = z.enum(["artist", "label"]).meta({ id: "FollowKind" });

export const FollowSchema = z
  .object({
    createdAt: z.string(),
    entityId: z.string(),
    id: z.string(),
    includeSimilar: z.boolean(),
    kind: FollowKindSchema,
    name: z.string(),
    slug: z.string(),
  })
  .meta({ id: "Follow" });

const SaveFollowBodySchema = z.looseObject({
  entityId: z.unknown().optional(),
  intent: z.unknown().optional(),
  kind: z.unknown().optional(),
});

export const listPrivateFollows = oc
  .route({
    method: "GET",
    operationId: "listPrivateFollows",
    path: "/me/follows",
    summary: "List the artists and labels the signed-in user follows",
    tags: ["Me"],
  })
  .output(z.object({ follows: z.array(FollowSchema), ok: z.literal(true) }));

export const savePrivateFollow = oc
  .route({
    method: "POST",
    operationId: "savePrivateFollow",
    path: "/me/follows",
    summary: "Follow an artist or label for the signed-in user",
    tags: ["Me"],
  })
  .input(SaveFollowBodySchema)
  .output(
    z.object({
      follow: z.object({
        createdAt: z.string(),
        entityId: z.string(),
        id: z.string(),
        includeSimilar: z.boolean(),
        kind: FollowKindSchema,
        name: z.string(),
        slug: z.string(),
      }),
      followsEmail: z.boolean(),
      ok: z.literal(true),
    }),
  );

export const deletePrivateFollow = oc
  .route({
    method: "DELETE",
    operationId: "deletePrivateFollow",
    path: "/me/follows/{id}",
    summary: "Unfollow an artist or label for the signed-in user",
    tags: ["Me"],
  })
  .input(z.object({ id: z.string() }))
  .output(z.object({ ok: z.literal(true) }));

export const meFollowsContract = {
  delete_private_follow: deletePrivateFollow,
  list_private_follows: listPrivateFollows,
  save_private_follow: savePrivateFollow,
};
