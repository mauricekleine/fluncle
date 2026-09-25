import { oc } from "@orpc/contract";
import * as z from "zod";

export const SavedSetSchema = z
  .object({
    createdAt: z.string(),
    id: z.string(),
    name: z.string(),
    setTokens: z.string(),
    taste: z.string().optional(),
    updatedAt: z.string(),
  })
  .meta({ id: "SavedSet" });

const SaveSetBodySchema = z.looseObject({
  name: z.unknown().optional(),
  set: z.unknown().optional(),
  taste: z.unknown().optional(),
});

export const listPrivateSavedSets = oc
  .route({
    method: "GET",
    operationId: "listPrivateSavedSets",
    path: "/me/saved-sets",
    summary: "List the signed-in user's saved sets",
    tags: ["Me"],
  })
  .output(z.object({ ok: z.literal(true), savedSets: z.array(SavedSetSchema) }));

export const savePrivateSet = oc
  .route({
    method: "POST",
    operationId: "savePrivateSet",
    path: "/me/saved-sets",
    summary: "Save a chained set for the signed-in user",
    tags: ["Me"],
  })
  .input(SaveSetBodySchema)
  .output(z.object({ ok: z.literal(true), savedSet: SavedSetSchema }));

export const updatePrivateSavedSet = oc
  .route({
    method: "PATCH",
    operationId: "updatePrivateSavedSet",
    path: "/me/saved-sets/{id}",
    summary: "Rename or overwrite a saved set",
    tags: ["Me"],
  })
  .input(z.looseObject({ id: z.string() }))
  .output(z.object({ ok: z.literal(true), savedSet: SavedSetSchema }));

export const deletePrivateSavedSet = oc
  .route({
    method: "DELETE",
    operationId: "deletePrivateSavedSet",
    path: "/me/saved-sets/{id}",
    summary: "Remove a saved set from the signed-in user's list",
    tags: ["Me"],
  })
  .input(z.object({ id: z.string() }))
  .output(z.object({ ok: z.literal(true) }));

export const meSetsContract = {
  delete_private_saved_set: deletePrivateSavedSet,
  list_private_saved_sets: listPrivateSavedSets,
  save_private_set: savePrivateSet,
  update_private_saved_set: updatePrivateSavedSet,
};
