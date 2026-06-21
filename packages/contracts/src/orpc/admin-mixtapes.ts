// The `admin-mixtapes` domain contract module — the mixtape authoring + the
// audio→Mixcloud / video→YouTube distribution control plane. Part of the admin
// fan-out (docs/orpc-migration-brief.md), built on the same pattern as
// `./admin-tracks.ts`.
//
// VERIFIED auth tiers against the live handlers:
//   - `list_mixtapes_admin` (GET) and `get_mixtape_social` (GET) — admin tier
//     (live `requireAdmin`): reads, agent-allowed.
//   - everything else — operator tier (live `requireOperator`): create/update/
//     delete, the members writes (POST append + PUT replace), publish, and every
//     distribution step. The agent gets a 403.
//
// Mutating bodies stay LOOSE/passthrough by design — the live routes pass the raw
// JSON straight to the server helpers (`createMixtape`/`updateMixtape`/
// `addTracksToMixtape`/`setMixtapeMembers`), which validate + throw their own
// codes — so the contract must not pre-reject. The distribution steps validate
// their own narrow fields in-handler (`invalid_request`/`mixtape_not_distributing`
// /`mixtape_no_log_id`/the YouTube 502s), kept byte-for-byte.

import { oc } from "@orpc/contract";
import * as z from "zod";
import { MixtapeDTOSchema, MixtapeSocialPostItemSchema } from "./_shared";

/** The `{ mixtape, ok }` envelope most mixtape ops return. */
const MixtapeEnvelope = z.object({ mixtape: MixtapeDTOSchema, ok: z.literal(true) });

/**
 * `list_mixtapes_admin` → `GET /admin/mixtapes` (operationId `listMixtapesAdmin`).
 *
 * Admin tier (live `requireAdmin`). The full mixtape list, hydrated + including
 * drafts (distinct from the public `list_mixtapes`). Preserves `{ mixtapes, ok }`.
 */
export const listMixtapesAdmin = oc
  .route({
    method: "GET",
    operationId: "listMixtapesAdmin",
    path: "/admin/mixtapes",
    summary: "List every mixtape (hydrated, including drafts)",
    tags: ["Admin"],
  })
  .output(z.object({ mixtapes: z.array(MixtapeDTOSchema), ok: z.literal(true) }));

/**
 * `create_mixtape` → `POST /admin/mixtapes` (operationId `createMixtape`).
 *
 * Operator tier (live `requireOperator`). LOOSE body — `createMixtape` validates.
 * Preserves `{ mixtape, ok }`.
 */
export const createMixtape = oc
  .route({
    method: "POST",
    operationId: "createMixtape",
    path: "/admin/mixtapes",
    summary: "Create a mixtape (draft)",
    tags: ["Admin"],
  })
  .input(z.looseObject({}))
  .output(MixtapeEnvelope);

/**
 * `update_mixtape` → `PATCH /admin/mixtapes/{mixtapeId}` (operationId
 * `updateMixtape`).
 *
 * Operator tier (live `requireOperator`). LOOSE body — `updateMixtape` validates.
 * Preserves `{ mixtape, ok }`.
 */
export const updateMixtape = oc
  .route({
    method: "PATCH",
    operationId: "updateMixtape",
    path: "/admin/mixtapes/{mixtapeId}",
    summary: "Update a mixtape's fields",
    tags: ["Admin"],
  })
  .input(z.looseObject({ mixtapeId: z.string() }))
  .output(MixtapeEnvelope);

/**
 * `delete_mixtape` → `DELETE /admin/mixtapes/{mixtapeId}` (operationId
 * `deleteMixtape`).
 *
 * Operator tier (live `requireOperator`). Preserves the live `{ ok }` envelope.
 */
export const deleteMixtape = oc
  .route({
    method: "DELETE",
    operationId: "deleteMixtape",
    path: "/admin/mixtapes/{mixtapeId}",
    summary: "Delete a mixtape",
    tags: ["Admin"],
  })
  .input(z.object({ mixtapeId: z.string() }))
  .output(z.object({ ok: z.literal(true) }));

/**
 * `add_mixtape_members` → `POST /admin/mixtapes/{mixtapeId}/members` (operationId
 * `addMixtapeMembers`).
 *
 * Operator tier (live `requireOperator`). APPEND to the tracklist (the board's
 * "Add to mixtape"). LOOSE body — `addTracksToMixtape` validates. Preserves
 * `{ mixtape, ok }`.
 */
export const addMixtapeMembers = oc
  .route({
    method: "POST",
    operationId: "addMixtapeMembers",
    path: "/admin/mixtapes/{mixtapeId}/members",
    summary: "Append tracks to a mixtape's tracklist (draft-only)",
    tags: ["Admin"],
  })
  .input(z.looseObject({ mixtapeId: z.string() }))
  .output(MixtapeEnvelope);

/**
 * `set_mixtape_members` → `PUT /admin/mixtapes/{mixtapeId}/members` (operationId
 * `setMixtapeMembers`).
 *
 * Operator tier (live `requireOperator`). REPLACE the whole tracklist (the
 * editor's drag-reorder). The SAME path as `add_mixtape_members`, distinguished by
 * the PUT method. LOOSE body — `setMixtapeMembers` validates. Preserves
 * `{ mixtape, ok }`.
 */
export const setMixtapeMembers = oc
  .route({
    method: "PUT",
    operationId: "setMixtapeMembers",
    path: "/admin/mixtapes/{mixtapeId}/members",
    summary: "Replace a mixtape's whole tracklist (draft-only)",
    tags: ["Admin"],
  })
  .input(z.looseObject({ mixtapeId: z.string() }))
  .output(MixtapeEnvelope);

/**
 * `publish_mixtape` → `POST /admin/mixtapes/{mixtapeId}/publish` (operationId
 * `publishMixtape`).
 *
 * Operator tier (live `requireOperator`). Mint the mixtape (draft → distributing,
 * committing its Log ID). Preserves `{ mixtape, ok }`.
 */
export const publishMixtape = oc
  .route({
    method: "POST",
    operationId: "publishMixtape",
    path: "/admin/mixtapes/{mixtapeId}/publish",
    summary: "Mint a mixtape (publish): commit its Log ID",
    tags: ["Admin"],
  })
  .input(z.object({ mixtapeId: z.string() }))
  .output(MixtapeEnvelope);

/**
 * `get_mixtape_social` → `GET /admin/mixtapes/{mixtapeId}/social` (operationId
 * `getMixtapeSocial`).
 *
 * Admin tier (live `requireAdmin`). The mixtape's per-platform distribution rows.
 * Preserves `{ mixtapeId, ok, posts }`.
 */
export const getMixtapeSocial = oc
  .route({
    method: "GET",
    operationId: "getMixtapeSocial",
    path: "/admin/mixtapes/{mixtapeId}/social",
    summary: "List a mixtape's per-platform distribution rows",
    tags: ["Admin"],
  })
  .input(z.object({ mixtapeId: z.string() }))
  .output(
    z.object({
      mixtapeId: z.string(),
      ok: z.literal(true),
      posts: z.array(MixtapeSocialPostItemSchema),
    }),
  );

/**
 * `finalize_mixtape_mixcloud` → `POST /admin/mixtapes/{mixtapeId}/mixcloud/finalize`
 * (operationId `finalizeMixtapeMixcloud`).
 *
 * Operator tier (live `requireOperator`). The CLI uploaded the audio to Mixcloud
 * and POSTs the resolved url here; the Worker records the post + flips the
 * mixtape published on first link. LOOSE body — the live route validates `url`
 * (`invalid_request`/400). Preserves `{ mixtape, ok, platform }`.
 */
export const finalizeMixtapeMixcloud = oc
  .route({
    method: "POST",
    operationId: "finalizeMixtapeMixcloud",
    path: "/admin/mixtapes/{mixtapeId}/mixcloud/finalize",
    summary: "Record a mixtape's published Mixcloud cloudcast",
    tags: ["Admin"],
  })
  .input(
    z.looseObject({
      externalId: z.unknown().optional(),
      mixtapeId: z.string(),
      url: z.unknown().optional(),
    }),
  )
  .output(z.object({ mixtape: MixtapeDTOSchema, ok: z.literal(true), platform: z.string() }));

/**
 * `initiate_mixtape_youtube` → `POST /admin/mixtapes/{mixtapeId}/youtube/initiate`
 * (operationId `initiateMixtapeYoutube`).
 *
 * Operator tier (live `requireOperator`). Step 1 of the YouTube resumable upload:
 * open the session, return the session URI + a short-lived token. LOOSE body — the
 * live route validates `contentLength` (`invalid_request`/400) and gates on the
 * mixtape status (`mixtape_not_distributing`/409, `mixtape_no_log_id`/409) +
 * YouTube errors (the 502s). Preserves `{ accessToken, ok, sessionUri }`.
 */
export const initiateMixtapeYoutube = oc
  .route({
    method: "POST",
    operationId: "initiateMixtapeYoutube",
    path: "/admin/mixtapes/{mixtapeId}/youtube/initiate",
    summary: "Open a mixtape's YouTube resumable upload session",
    tags: ["Admin"],
  })
  .input(
    z.looseObject({
      contentLength: z.unknown().optional(),
      contentType: z.unknown().optional(),
      mixtapeId: z.string(),
    }),
  )
  .output(z.object({ accessToken: z.string(), ok: z.literal(true), sessionUri: z.string() }));

/**
 * `finalize_mixtape_youtube` → `POST /admin/mixtapes/{mixtapeId}/youtube/finalize`
 * (operationId `finalizeMixtapeYoutube`).
 *
 * Operator tier (live `requireOperator`). Step 3: the CLI finished the PUT and
 * reports the videoId; record it published (best-effort thumbnail). LOOSE body —
 * the live route validates `videoId` (`invalid_request`/400). Preserves
 * `{ mixtape, ok, platform }`.
 */
export const finalizeMixtapeYoutube = oc
  .route({
    method: "POST",
    operationId: "finalizeMixtapeYoutube",
    path: "/admin/mixtapes/{mixtapeId}/youtube/finalize",
    summary: "Record a mixtape's uploaded YouTube video",
    tags: ["Admin"],
  })
  .input(z.looseObject({ mixtapeId: z.string(), videoId: z.unknown().optional() }))
  .output(z.object({ mixtape: MixtapeDTOSchema, ok: z.literal(true), platform: z.string() }));

/**
 * `publish_mixtape_youtube` → `POST /admin/mixtapes/{mixtapeId}/youtube/publish`
 * (operationId `publishMixtapeYoutube`).
 *
 * Operator tier (live `requireOperator`). The recurring human gate: flip the
 * unlisted mixtape video to public. Gates on the youtube distribution row
 * (`youtube_not_distributed`/409) + YouTube errors (502). Preserves `{ ok, url }`.
 */
export const publishMixtapeYoutube = oc
  .route({
    method: "POST",
    operationId: "publishMixtapeYoutube",
    path: "/admin/mixtapes/{mixtapeId}/youtube/publish",
    summary: "Flip a mixtape's unlisted YouTube video to public",
    tags: ["Admin"],
  })
  .input(z.object({ mixtapeId: z.string() }))
  .output(z.object({ ok: z.literal(true), url: z.string() }));

/** The `admin-mixtapes` domain's ops, merged into the root contract by `./index.ts`. */
export const adminMixtapesContract = {
  add_mixtape_members: addMixtapeMembers,
  create_mixtape: createMixtape,
  delete_mixtape: deleteMixtape,
  finalize_mixtape_mixcloud: finalizeMixtapeMixcloud,
  finalize_mixtape_youtube: finalizeMixtapeYoutube,
  get_mixtape_social: getMixtapeSocial,
  initiate_mixtape_youtube: initiateMixtapeYoutube,
  list_mixtapes_admin: listMixtapesAdmin,
  publish_mixtape: publishMixtape,
  publish_mixtape_youtube: publishMixtapeYoutube,
  set_mixtape_members: setMixtapeMembers,
  update_mixtape: updateMixtape,
};
