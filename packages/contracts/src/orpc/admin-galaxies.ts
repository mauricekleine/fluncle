// The `admin-galaxies` domain contract module — the sonic galaxy map's admin surface
// (browse-by-feel RFC). Four ops:
//
//   - `list_galaxies_admin` — admin tier (agent-allowed read): the FULL map incl.
//     centroids, machine handles, unnamed + retired rows, split flags, and the derived
//     member count. Serves BOTH the operator naming view (Slice 3) and the on-box
//     `fluncle-cluster` cron's map read (Slice 2).
//   - `update_galaxy` — OPERATOR tier: the operator's editorial acts — set `name` +
//     `slug`, rename, request a split. Naming is publish-class (it mints a public URL),
//     so `operatorGuard` is load-bearing (an agent token 403s) — the `note`
//     OPERATOR_ONLY_FIELDS precedent, applied to galaxies.
//   - `update_galaxy_map` — admin tier: the cron's transactional map write. The Worker
//     MINTS the id + `galaxySlug(id, attempt)` handle server-side for new clusters
//     (`id: null` rows) and returns the minted rows — the box never mints identity.
//   - `list_track_embeddings` — admin tier: the embedded corpus `{ trackId, embedding }`,
//     cursor-paginated (the `list_tracks_admin` cursor precedent), the cluster engine's
//     input. Lives here (not `admin-tracks`) because it exists only to feed the sweep.
//
// No collision with the game's save ops: the `me-galaxy` domain
// (`get_private_galaxy_progress` / `merge_private_galaxy_progress` /
// `collect_private_galaxy_log`) is the player-progress slice and stays untouched.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * One galaxy in the FULL admin shape — every column the naming view + the cron read.
 * `name`/`slug` are null until the operator names it; `centroid` is the 1024-d nightly
 * assignment anchor; `memberCount` is derived; `silhouette` is the per-cluster
 * coherence evidence (display-only, null until the engine computes it in Slice 2/3);
 * `retiredAt`/`splitRequestedAt` are the lifecycle stamps. The machine `handle` is the
 * permanent admin/CLI identity and NEVER renders publicly.
 */
export const GalaxyAdminItemSchema = z
  .object({
    centroid: z.array(z.number()),
    createdAt: z.string(),
    handle: z.string(),
    id: z.string(),
    memberCount: z.number(),
    name: z.string().nullable(),
    retiredAt: z.string().nullable(),
    silhouette: z.number().nullable(),
    slug: z.string().nullable(),
    splitRequestedAt: z.string().nullable(),
    updatedAt: z.string(),
  })
  .meta({ id: "GalaxyAdminItem" });

/**
 * `list_galaxies_admin` → `GET /admin/galaxies` (operationId `listGalaxiesAdmin`).
 *
 * Admin tier (agent-allowed read — the box's `fluncle-cluster` cron reads the prior
 * map + split flags here with its agent token, the `list_tracks_admin` precedent).
 * The full map: named, unnamed, and retired galaxies, each with its centroid, handle,
 * derived member count, and lifecycle stamps. `{ ok, galaxies }`.
 */
export const listGalaxiesAdmin = oc
  .route({
    method: "GET",
    operationId: "listGalaxiesAdmin",
    path: "/admin/galaxies",
    summary: "The full galaxy map (named + unnamed + retired, with centroids + evidence)",
    tags: ["Admin"],
  })
  .output(z.object({ galaxies: z.array(GalaxyAdminItemSchema), ok: z.literal(true) }));

/**
 * `update_galaxy` → `PATCH /admin/galaxies/{id}` (operationId `updateGalaxy`).
 *
 * OPERATOR tier (`adminAuth` + `operatorGuard`). The operator's editorial acts on one
 * galaxy: set `name` + `slug` (naming mints the public URL), rename (deliberate), or
 * request a split (`requestSplit: true` stamps `split_requested_at`; the next nightly
 * tick consumes it). Naming is publish-class, so an agent token 403s here. `{ ok, galaxy }`.
 */
export const updateGalaxy = oc
  .route({
    method: "PATCH",
    operationId: "updateGalaxy",
    path: "/admin/galaxies/{id}",
    summary: "Name, rename, or request a split of one galaxy (operator)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      requestSplit: z.boolean().optional(),
      slug: z.string().optional(),
    }),
  )
  .output(z.object({ galaxy: GalaxyAdminItemSchema, ok: z.literal(true) }));

/**
 * `update_galaxy_map` → `PUT /admin/galaxies/map` (operationId `updateGalaxyMap`).
 *
 * Admin tier — the cron's transactional map write (one `db.batch(_, "write")`). Each
 * cluster row carries its centroid and either an existing `id` (upsert its centroid /
 * retire it) or `id: null` for a NEW cluster (cold start, or a split's smaller child):
 * the Worker mints the id + `galaxySlug(id, attempt)` handle server-side and returns
 * every resulting row so the box can then write per-finding assignments that point at
 * real ids. `retire: true` sets `retired_at` (the row is kept, the id never recycled).
 * The box never mints identity — `galaxy-slug.ts` is a workspace package the standalone
 * baked sweep scripts can't import. `{ ok, galaxies }` (the full resulting map).
 */
export const updateGalaxyMap = oc
  .route({
    method: "PUT",
    operationId: "updateGalaxyMap",
    path: "/admin/galaxies/map",
    summary: "Transactional galaxy-map write (upsert centroids, mint new ids, retire)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      clusters: z.array(
        z.object({
          centroid: z.array(z.number()),
          // Clear the parent's `split_requested_at` in the SAME batch that upserts its
          // centroid — the agent-tier way the nightly tick CONSUMES a split it just ran
          // (the operator sets the flag via the OPERATOR-tier `update_galaxy`, which the
          // box's agent token cannot call; consuming it rides this admin-tier map write).
          clearSplitRequest: z.boolean().optional(),
          id: z.string().nullable(),
          retire: z.boolean().optional(),
        }),
      ),
    }),
  )
  .output(z.object({ galaxies: z.array(GalaxyAdminItemSchema), ok: z.literal(true) }));

/**
 * One embedded finding — the cluster engine's input row. `galaxyId` is the finding's
 * CURRENT sonic-galaxy assignment (null when unplaced): the nightly sweep diffs the
 * nearest-centroid result against it and writes back ONLY the changed assignments (the
 * write-order contract's "a handful per night"), so an unchanged corpus never churns
 * the `/log` edge cache.
 */
export const TrackEmbeddingSchema = z
  .object({
    embedding: z.array(z.number()),
    galaxyId: z.string().nullable(),
    trackId: z.string(),
  })
  .meta({ id: "TrackEmbedding" });

/**
 * `list_track_embeddings` → `GET /admin/tracks/embeddings` (operationId
 * `listTrackEmbeddings`).
 *
 * Admin tier (agent-allowed read — the `fluncle-cluster` cron's agent token). The
 * embedded corpus (`log_id IS NOT NULL AND embedding_json IS NOT NULL`), cursor-paginated
 * over a stable `track_id` key (the `list_tracks_admin` cursor precedent — limit/offset
 * over a table the embed cron mutates every 5 minutes would skip/duplicate rows). `limit`
 * is a tolerant optional string parsed in-handler. Path-shadowing is a non-issue: oRPC's
 * matcher routes static segments (`/tracks/embeddings`) ahead of params. `{ ok, embeddings,
 * nextCursor }` (`nextCursor` null when the corpus is drained).
 */
export const listTrackEmbeddings = oc
  .route({
    method: "GET",
    operationId: "listTrackEmbeddings",
    path: "/admin/tracks/embeddings",
    summary: "The embedded corpus (trackId + MuQ vector), cursor-paginated (the cluster input)",
    tags: ["Admin"],
  })
  .input(z.object({ cursor: z.string().optional(), limit: z.string().optional() }))
  .output(
    z.object({
      embeddings: z.array(TrackEmbeddingSchema),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
    }),
  );

/** The `admin-galaxies` domain's ops, merged into the root contract by `./index.ts`. */
export const adminGalaxiesContract = {
  list_galaxies_admin: listGalaxiesAdmin,
  list_track_embeddings: listTrackEmbeddings,
  update_galaxy: updateGalaxy,
  update_galaxy_map: updateGalaxyMap,
};
