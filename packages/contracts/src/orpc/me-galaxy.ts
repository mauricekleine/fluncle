// The `me-galaxy` domain contract module — the Galaxy-progress slice of the `/me`
// private-user tier (the game's cross-device save). All three ops are
// cookie-session authenticated (the read tier 401s without a session; the writes
// also require the CSRF mutation token). A future wave adds an op here and one
// import line in `./index.ts`, touching no other domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * A user's Galaxy progress as `getGalaxyProgress` returns it (the live GET/PUT
 * /me/galaxy-progress body, and the embedded `progress` in the export). Carries
 * its own `ok: true` because the live helper's object is returned verbatim — both
 * by the progress routes and inside the export envelope. `lastPlayedAt`/`updatedAt`
 * are absent until the first play, so both are optional.
 */
export const GalaxyProgressSchema = z
  .object({
    collectedLogIds: z.array(z.string()),
    deaths: z.number(),
    lastPlayedAt: z.string().optional(),
    ok: z.literal(true),
    updatedAt: z.string().optional(),
    wins: z.number(),
  })
  .meta({ id: "GalaxyProgress" });

/**
 * The merge request body (the live PUT /me/galaxy-progress body, handed to
 * `mergeGalaxyProgress`). LOOSE + every field OPTIONAL UNKNOWN: the live route
 * does NOT schema-validate — `mergeGalaxyProgress` filters `collectedLogIds` to
 * strings and clamps `deaths`/`wins` itself. A permissive contract keeps oRPC
 * from pre-rejecting a valid-JSON body so that filtering stays byte-for-byte.
 */
const GalaxyMergeBodySchema = z.looseObject({
  collectedLogIds: z.unknown().optional(),
  deaths: z.unknown().optional(),
  wins: z.unknown().optional(),
});

/**
 * The collect-log request body (the live POST /me/galaxy-progress/logs body). The
 * live route requires `logId` to be a string (else 400 `invalid_request`); the
 * contract keeps it LOOSE optional UNKNOWN so that exact in-handler check — and
 * its precise code — stays the live behavior rather than an oRPC schema 400.
 */
const GalaxyLogBodySchema = z.looseObject({
  logId: z.unknown().optional(),
});

/**
 * `get_private_galaxy_progress` → `GET /me/galaxy-progress`
 * (operationId `getPrivateGalaxyProgress`).
 *
 * The signed-in user's Galaxy save: collected Log IDs + lifetime counters. Reuses
 * the live `getGalaxyProgress`; the body is its object verbatim (carries `ok`). A
 * missing session is the rails-encoded 401 (`auth_required`), not an output shape.
 */
export const getPrivateGalaxyProgress = oc
  .route({
    method: "GET",
    operationId: "getPrivateGalaxyProgress",
    path: "/me/galaxy-progress",
    summary: "Get the signed-in user's Galaxy progress",
    tags: ["Me"],
  })
  .output(GalaxyProgressSchema);

/**
 * `merge_private_galaxy_progress` → `PUT /me/galaxy-progress`
 * (operationId `mergePrivateGalaxyProgress`).
 *
 * Merge a client's local Galaxy progress into the server save (collect each Log
 * ID, increment counters), then return the merged progress — the same
 * `getGalaxyProgress` body. CSRF-guarded (the mutation token); reuses
 * `mergeGalaxyProgress` so the filtering/clamping and its codes stay exact.
 */
export const mergePrivateGalaxyProgress = oc
  .route({
    method: "PUT",
    operationId: "mergePrivateGalaxyProgress",
    path: "/me/galaxy-progress",
    summary: "Merge local Galaxy progress into the server save",
    tags: ["Me"],
  })
  .input(GalaxyMergeBodySchema)
  .output(GalaxyProgressSchema);

/**
 * `collect_private_galaxy_log` → `POST /me/galaxy-progress/logs`
 * (operationId `collectPrivateGalaxyLog`).
 *
 * Record that the signed-in user has collected a finding by its Log ID (the
 * game's per-find write). CSRF-guarded; reuses `collectLogId`, preserving the
 * `{ logId, ok: true }` body and the live `invalid_request`/400 (missing logId)
 * and `log_not_found`/404 codes.
 *
 * NOTE: the coverage scaffold originally placeholdered this as a GET
 * `list_private_galaxy_logs`. There is no list-logs route in the live API — the
 * only `/me/galaxy-progress/logs` route is this POST collect-one — so the op is
 * named for what it does. (Deviation called out in the PR.)
 */
export const collectPrivateGalaxyLog = oc
  .route({
    method: "POST",
    operationId: "collectPrivateGalaxyLog",
    path: "/me/galaxy-progress/logs",
    summary: "Collect a finding into the signed-in user's Galaxy log",
    tags: ["Me"],
  })
  .input(GalaxyLogBodySchema)
  .output(z.object({ logId: z.string(), ok: z.literal(true) }));

/**
 * One collected finding in the signed-in user's Galaxy collection, enriched with
 * the finding it points at (title, artists, cover, galaxy). `galaxyName`/`galaxySlug`
 * are present only when the finding's galaxy is operator-NAMED — an unnamed or
 * unassigned finding groups under the client's "Uncharted" bucket (the DTO's
 * `galaxy` omission rule, applied to the collection). `firstCollectedAt` is the
 * user's own log date (their Found date for that star), never the archive's.
 */
export const GalaxyCollectionItemSchema = z
  .object({
    artists: z.array(z.string()),
    firstCollectedAt: z.string(),
    galaxyName: z.string().optional(),
    galaxySlug: z.string().optional(),
    imageUrl: z.string().optional(),
    logId: z.string(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "GalaxyCollectionItem" });

/**
 * A named galaxy's completion line: how many findings the archive holds there
 * (`total`, certified + named only) against how many this user has logged
 * (`collected`). Only NAMED galaxies appear — the unnamed remainder is not
 * enumerated (the map is public only once the operator names it).
 */
export const GalaxyCompletionSchema = z
  .object({
    collected: z.number(),
    name: z.string(),
    slug: z.string(),
    total: z.number(),
  })
  .meta({ id: "GalaxyCompletion" });

/**
 * `list_private_galaxy_collection` → `GET /me/galaxy-collection`
 * (operationId `listPrivateGalaxyCollection`).
 *
 * The signed-in user's Galaxy collection as a browsable object: every collected
 * finding enriched via the findings/tracks join (title, artists, cover, galaxy,
 * the user's first-collected date), plus the per-named-galaxy completion lines.
 * The read sibling of `collectPrivateGalaxyLog`; same cookie-session tier as
 * `getPrivateGalaxyProgress` (401 without a session, no CSRF — a read).
 */
export const listPrivateGalaxyCollection = oc
  .route({
    method: "GET",
    operationId: "listPrivateGalaxyCollection",
    path: "/me/galaxy-collection",
    summary: "List the signed-in user's Galaxy collection",
    tags: ["Me"],
  })
  .output(
    z.object({
      collection: z.array(GalaxyCollectionItemSchema),
      galaxies: z.array(GalaxyCompletionSchema),
      ok: z.literal(true),
    }),
  );

export type GalaxyCollectionItem = z.infer<typeof GalaxyCollectionItemSchema>;
export type GalaxyCompletion = z.infer<typeof GalaxyCompletionSchema>;

/** The `me-galaxy` domain's ops, merged into the root contract by `./index.ts`. */
export const meGalaxyContract = {
  collect_private_galaxy_log: collectPrivateGalaxyLog,
  get_private_galaxy_progress: getPrivateGalaxyProgress,
  list_private_galaxy_collection: listPrivateGalaxyCollection,
  merge_private_galaxy_progress: mergePrivateGalaxyProgress,
};
