// The `me-watches` domain contract module — the watched-entities slice of the `/me`
// private-user tier (a signed-in user's watched artists and labels). The list is a
// cookie-session read; watch/unwatch also require the CSRF mutation token. The saved-sets
// (`me-sets`) sibling is the precedent this follows exactly, one tier over.
//
// THE ACCOUNT NEVER GATES THE FEATURE. Every entity page stays fully usable signed-out —
// watching only SAVES the entity to your account so a future digest can reach for it. The
// anonymous watcher equivalent already exists (the per-entity fresh feeds,
// `/artist/<slug>/fresh.xml`); these ops touch none of it.
//
// The email digest that will eventually READ these watches is DEFERRED (operator ruling
// 2026-07-19). This is the substrate only: storage, ops, and the UI. `includeSimilar` is
// headroom for that digest — it has no consumer and no UI yet.

import { oc } from "@orpc/contract";
import * as z from "zod";

/** The two kinds a watch can point at — an artist or a label entity. */
export const WatchKindSchema = z.enum(["artist", "label"]).meta({ id: "WatchKind" });

/**
 * A watch as `listWatches` returns it. `name` is joined from the entity's own row at read
 * time (never denormalized onto the watch), and `slug` links the account row back to the
 * entity page. `includeSimilar` rides on the row for completeness; it has no consumer yet.
 */
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

/**
 * The watch request body (handed to `saveWatch`). LOOSE + optional UNKNOWN, matching the
 * saved-sets/saved-findings bodies: `saveWatch` resolves `kind`/`entityId` and validates
 * itself (emitting `invalid_request`/400, `entity_not_found`/404), so a permissive contract
 * keeps oRPC from pre-rejecting and the logic stays in one place.
 */
const SaveWatchBodySchema = z.looseObject({
  entityId: z.unknown().optional(),
  kind: z.unknown().optional(),
});

/**
 * `list_private_watches` → `GET /me/watches` (operationId `listPrivateWatches`).
 *
 * The signed-in user's watched artists and labels, newest first. A missing session is the
 * rails-encoded 401 (`auth_required`).
 */
export const listPrivateWatches = oc
  .route({
    method: "GET",
    operationId: "listPrivateWatches",
    path: "/me/watches",
    summary: "List the signed-in user's watched artists and labels",
    tags: ["Me"],
  })
  .output(z.object({ ok: z.literal(true), watches: z.array(WatchSchema) }));

/**
 * `save_private_watch` → `POST /me/watches` (operationId `savePrivateWatch`).
 *
 * Watch an artist or label (by `kind` + the entity's id). Watching the same entity twice
 * upserts on the (user, kind, entity) key — idempotent, never a duplicate. CSRF-guarded;
 * an unknown entity is `entity_not_found`/404, a bad kind is `invalid_request`/400.
 */
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

/**
 * `delete_private_watch` → `DELETE /me/watches/{id}` (operationId `deletePrivateWatch`).
 *
 * Stop watching an entity — scoped to the owner (another user's watch id is a 404).
 * CSRF-guarded; the bare `{ ok: true }` body.
 */
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

/** The `me-watches` domain's ops, merged into the root contract by `./index.ts`. */
export const meWatchesContract = {
  delete_private_watch: deletePrivateWatch,
  list_private_watches: listPrivateWatches,
  save_private_watch: savePrivateWatch,
};
