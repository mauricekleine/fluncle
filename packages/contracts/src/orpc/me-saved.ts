// The `me-saved` domain contract module — the saved-findings slice of the `/me`
// private-user tier (a signed-in user's bookmarks). The list is cookie-session
// read; save/unsave also require the CSRF mutation token. A future wave adds an
// op here and one import line in `./index.ts`, touching no other domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * A saved finding as `listSavedFindings` returns it (a row of the live GET
 * /me/saved-findings body). `note` is absent when the user saved no note.
 */
export const SavedFindingSchema = z
  .object({
    artists: z.array(z.string()),
    logId: z.string(),
    note: z.string().optional(),
    savedAt: z.string(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "SavedFinding" });

/**
 * The save request body (the live POST /me/saved-findings body, handed to
 * `saveFinding`). LOOSE + optional UNKNOWN: the live route does NOT
 * schema-validate — `saveFinding` resolves `trackId`/`logId` and the optional
 * `note` itself, emitting `invalid_request`/`track_not_found`. A permissive
 * contract keeps oRPC from pre-rejecting so that logic stays byte-for-byte.
 */
const SaveFindingBodySchema = z.looseObject({
  logId: z.unknown().optional(),
  note: z.unknown().optional(),
  trackId: z.unknown().optional(),
});

/**
 * `list_private_saved_findings` → `GET /me/saved-findings`
 * (operationId `listPrivateSavedFindings`).
 *
 * The signed-in user's saved findings, newest first. Reuses `listSavedFindings`;
 * the `{ ok: true, savedFindings }` envelope is preserved. A missing session is
 * the rails-encoded 401 (`auth_required`).
 */
export const listPrivateSavedFindings = oc
  .route({
    method: "GET",
    operationId: "listPrivateSavedFindings",
    path: "/me/saved-findings",
    summary: "List the signed-in user's saved findings",
    tags: ["Me"],
  })
  .output(z.object({ ok: z.literal(true), savedFindings: z.array(SavedFindingSchema) }));

/**
 * `save_private_finding` → `POST /me/saved-findings`
 * (operationId `savePrivateFinding`).
 *
 * Save a finding (by trackId or Log ID, with an optional note). CSRF-guarded;
 * reuses `saveFinding`, preserving the `{ ok: true, savedFinding }` envelope (the
 * echoed finding carries logId/note/savedAt/trackId — no title/artists) and the
 * live `invalid_request`/400, `track_not_found`/404 codes.
 */
export const savePrivateFinding = oc
  .route({
    method: "POST",
    operationId: "savePrivateFinding",
    path: "/me/saved-findings",
    summary: "Save a finding for the signed-in user",
    tags: ["Me"],
  })
  .input(SaveFindingBodySchema)
  .output(
    z.object({
      ok: z.literal(true),
      savedFinding: z.object({
        logId: z.string(),
        note: z.string().optional(),
        savedAt: z.string(),
        trackId: z.string(),
      }),
    }),
  );

/**
 * `unsave_private_finding` → `DELETE /me/saved-findings/{trackId}`
 * (operationId `unsavePrivateFinding`).
 *
 * Remove a saved finding (the path param resolves by trackId OR Log ID, matching
 * `findTrackByTrackOrLog`). CSRF-guarded; reuses `deleteSavedFinding`, preserving
 * the bare `{ ok: true }` body and the `track_not_found`/404 code.
 */
export const unsavePrivateFinding = oc
  .route({
    method: "DELETE",
    operationId: "unsavePrivateFinding",
    path: "/me/saved-findings/{trackId}",
    summary: "Remove a finding from the signed-in user's saved list",
    tags: ["Me"],
  })
  .input(z.object({ trackId: z.string() }))
  .output(z.object({ ok: z.literal(true) }));

/** The `me-saved` domain's ops, merged into the root contract by `./index.ts`. */
export const meSavedContract = {
  list_private_saved_findings: listPrivateSavedFindings,
  save_private_finding: savePrivateFinding,
  unsave_private_finding: unsavePrivateFinding,
};
