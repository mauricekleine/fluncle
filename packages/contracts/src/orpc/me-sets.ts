// The `me-sets` domain contract module — the saved-`/mix`-sets slice of the `/me`
// private-user tier (a signed-in user's chained sets). The list is a cookie-session
// read; save/update/delete also require the CSRF mutation token. The saved-findings
// (`me-saved`) sibling is the precedent this follows exactly, one tier over.
//
// THE ACCOUNT NEVER GATES THE TOOL. `/mix` stays fully usable signed-out — the set
// and its taste live in the URL, the wire format. These ops only let a signed-in
// user SAVE a chain so it survives the tab; the anonymous, URL-based path is
// untouched.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * A saved set as `listSavedSets` returns it. `setTokens` is the serialized `?set=`
 * chain and `taste` the serialized `?taste=` seed — echoed VERBATIM, so the account
 * page opens a set by handing them straight back to `/mix` (its loader does the
 * rest). `taste` is absent when the chain carried no seed.
 */
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

/**
 * The save request body (handed to `saveSet`). LOOSE + optional UNKNOWN: the helper
 * re-parses `set`/`taste` through the shared `/mix` codec and validates itself
 * (emitting `empty_set`/400), so a permissive contract keeps oRPC from pre-rejecting
 * and the logic stays byte-for-byte.
 */
const SaveSetBodySchema = z.looseObject({
  name: z.unknown().optional(),
  set: z.unknown().optional(),
  taste: z.unknown().optional(),
});

/**
 * `list_private_saved_sets` → `GET /me/saved-sets`
 * (operationId `listPrivateSavedSets`).
 *
 * The signed-in user's saved sets, most-recently-touched first. A missing session
 * is the rails-encoded 401 (`auth_required`).
 */
export const listPrivateSavedSets = oc
  .route({
    method: "GET",
    operationId: "listPrivateSavedSets",
    path: "/me/saved-sets",
    summary: "List the signed-in user's saved sets",
    tags: ["Me"],
  })
  .output(z.object({ ok: z.literal(true), savedSets: z.array(SavedSetSchema) }));

/**
 * `save_private_set` → `POST /me/saved-sets` (operationId `savePrivateSet`).
 *
 * Save a chained set (the serialized `?set=` chain + optional `?taste=` seed, plus
 * an optional name — the server derives one from the first track + date when it's
 * blank). CSRF-guarded; an empty chain is `empty_set`/400.
 */
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

/**
 * `update_private_saved_set` → `PATCH /me/saved-sets/{id}`
 * (operationId `updatePrivateSavedSet`).
 *
 * Rename a saved set and/or overwrite its chain — scoped to the owner (another
 * user's id is a 404). LOOSE beyond the path `id`, matching the save body; the
 * helper validates. CSRF-guarded.
 */
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

/**
 * `delete_private_saved_set` → `DELETE /me/saved-sets/{id}`
 * (operationId `deletePrivateSavedSet`).
 *
 * Remove a saved set — scoped to the owner (another user's id is a 404).
 * CSRF-guarded; the bare `{ ok: true }` body.
 */
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

/** The `me-sets` domain's ops, merged into the root contract by `./index.ts`. */
export const meSetsContract = {
  delete_private_saved_set: deletePrivateSavedSet,
  list_private_saved_sets: listPrivateSavedSets,
  save_private_set: savePrivateSet,
  update_private_saved_set: updatePrivateSavedSet,
};
