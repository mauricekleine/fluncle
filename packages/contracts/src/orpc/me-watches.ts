import { oc } from "@orpc/contract";
import * as z from "zod";

export const WatchKindSchema = z.enum(["artist", "label"]).meta({ id: "WatchKind" });

export const WatchSchema = z
  .object({
    createdAt: z.string(),
    entityId: z.string(),
    id: z.string(),
    includeSimilar: z.boolean(),
    kind: WatchKindSchema,
    name: z.string(),
    slug: z.string(),
  })
  .meta({ id: "Watch" });

const SaveWatchBodySchema = z.looseObject({
  entityId: z.unknown().optional(),
  kind: z.unknown().optional(),
});

export const listPrivateWatches = oc
  .route({
    method: "GET",
    operationId: "listPrivateWatches",
    path: "/me/watches",
    summary: "List the signed-in user's watched artists and labels",
    tags: ["Me"],
  })
  .output(z.object({ ok: z.literal(true), watches: z.array(WatchSchema) }));

export const savePrivateWatch = oc
  .route({
    method: "POST",
    operationId: "savePrivateWatch",
    path: "/me/watches",
    summary: "Watch an artist or label for the signed-in user",
    tags: ["Me"],
  })
  .input(SaveWatchBodySchema)
  .output(
    z.object({
      ok: z.literal(true),
      watch: z.object({
        createdAt: z.string(),
        entityId: z.string(),
        id: z.string(),
        includeSimilar: z.boolean(),
        kind: WatchKindSchema,
      }),
    }),
  );

export const deletePrivateWatch = oc
  .route({
    method: "DELETE",
    operationId: "deletePrivateWatch",
    path: "/me/watches/{id}",
    summary: "Stop watching an entity from the signed-in user's list",
    tags: ["Me"],
  })
  .input(z.object({ id: z.string() }))
  .output(z.object({ ok: z.literal(true) }));

export const meWatchesContract = {
  delete_private_watch: deletePrivateWatch,
  list_private_watches: listPrivateWatches,
  save_private_watch: savePrivateWatch,
};
