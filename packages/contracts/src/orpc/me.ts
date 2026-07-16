// The `me` domain contract module — the core of the `/me` private-user tier (the
// logged-in Spotify-login user's own account). `get_current_private_user` and the
// CSRF token op are session reads; profile/delete/export are CSRF-guarded writes;
// the export-fetch and submissions list are session reads. The Galaxy-progress
// and saved-findings slices live in `./me-galaxy.ts` / `./me-saved.ts` to keep
// each module small. A future wave adds an op here and one import line in
// `./index.ts`, touching no other domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";
import { GalaxyProgressSchema } from "./me-galaxy";
import { UserPreferencesSchema } from "./me-preferences";
import { SavedFindingSchema } from "./me-saved";
import { PublicUserSchema } from "./_shared";

/**
 * A submission as the SIGNED-IN user sees their own (`listUserSubmissions`). The
 * status is the user-facing projection (`logged`/`passed_on`/`pending_review`),
 * distinct from the admin `Submission`'s raw status. `note` is absent when none.
 */
export const PrivateSubmissionSchema = z
  .object({
    artists: z.array(z.string()),
    createdAt: z.string(),
    id: z.string(),
    note: z.string().optional(),
    source: z.string(),
    spotifyUrl: z.string(),
    status: z.enum(["logged", "passed_on", "pending_review"]),
    title: z.string(),
  })
  .meta({ id: "PrivateSubmission" });

/**
 * The profile-update body (the live PATCH /me/profile body, handed to
 * `updatePrivateUsername`). LOOSE + optional UNKNOWN: the live route does NOT
 * schema-validate — the helper normalizes `username`/`displayUsername` and emits
 * `invalid_request`/`invalid_username`/`username_taken` itself. A permissive
 * contract keeps that validation (and its codes) byte-for-byte.
 */
const ProfileBodySchema = z.looseObject({
  displayUsername: z.unknown().optional(),
  // The freeform display name (Settings "Name") — additive, the two-name model.
  name: z.unknown().optional(),
  username: z.unknown().optional(),
});

/**
 * `get_current_private_user` → `GET /me` (operationId `getCurrentPrivateUser`).
 *
 * The current public session — `{ ok: true, googleEnabled, user }` where `user` is
 * the signed-in `PublicUser` or `null` when there is no session. UNLIKE the rest of
 * the tier this op does NOT 401 on an absent session; it returns `user: null` (the
 * live `meResponse`). So it stays a plain read, not on `privateUserProcedure`.
 *
 * `googleEnabled` reports whether "Continue with Google" is live server-side (both
 * `GOOGLE_CLIENT_*` creds present) so the account UI shows the button only when it
 * works — never a dead button. Session-independent (present on the `user: null`
 * body too), since the sign-in form reads it while signed out.
 */
export const getCurrentPrivateUser = oc
  .route({
    method: "GET",
    operationId: "getCurrentPrivateUser",
    path: "/me",
    summary: "Get the current public session (user or null)",
    tags: ["Me"],
  })
  .output(
    z.object({
      googleEnabled: z.boolean(),
      ok: z.literal(true),
      user: PublicUserSchema.nullable(),
    }),
  );

/**
 * `get_private_mutation_token` → `GET /me/csrf`
 * (operationId `getPrivateMutationToken`).
 *
 * Issue the per-user CSRF mutation token the `/me` writes require. A SIGNED-IN
 * read (401 `auth_required` without a session). Reuses `createCsrfToken`,
 * preserving the `{ csrfToken, ok: true }` body.
 */
export const getPrivateMutationToken = oc
  .route({
    method: "GET",
    operationId: "getPrivateMutationToken",
    path: "/me/csrf",
    summary: "Issue the account mutation (CSRF) token",
    tags: ["Me"],
  })
  .output(z.object({ csrfToken: z.string(), ok: z.literal(true) }));

/**
 * `update_private_profile` → `PATCH /me/profile`
 * (operationId `updatePrivateProfile`).
 *
 * Set the signed-in user's username/display name. CSRF-guarded; reuses
 * `updatePrivateUsername`, preserving the `{ ok: true, user }` envelope and the
 * `invalid_request`/400, `invalid_username`/400, `username_taken`/409 codes.
 */
export const updatePrivateProfile = oc
  .route({
    method: "PATCH",
    operationId: "updatePrivateProfile",
    path: "/me/profile",
    summary: "Update the signed-in user's profile",
    tags: ["Me"],
  })
  .input(ProfileBodySchema)
  .output(z.object({ ok: z.literal(true), user: PublicUserSchema }));

/**
 * `delete_private_account` → `POST /me/delete`
 * (operationId `deletePrivateAccount`). POST on a `/delete` path, not DELETE /me.
 *
 * Irreversibly delete the signed-in account (anonymizes submissions, drops the
 * rest). CSRF-guarded with the daily-window rate limit; reuses `deleteAccount`,
 * preserving the `{ ok: true, summary }` envelope (the per-area disposition map).
 */
export const deletePrivateAccount = oc
  .route({
    method: "POST",
    operationId: "deletePrivateAccount",
    path: "/me/delete",
    summary: "Delete the signed-in account",
    tags: ["Me"],
  })
  .output(
    z.object({
      ok: z.literal(true),
      summary: z.object({
        credentials: z.string(),
        galaxyProgress: z.string(),
        savedFindings: z.string(),
        sessions: z.string(),
        submissions: z.string(),
        user: z.string(),
        verifications: z.string(),
      }),
    }),
  );

/**
 * `export_private_account_data` → `POST /me/export`
 * (operationId `exportPrivateAccountData`).
 *
 * Generate the signed-in account's data export (a one-shot bundle of profile +
 * progress + saved + submissions, recorded with a 24h expiry). CSRF-guarded with
 * the daily-window rate limit; reuses `exportAccountData`, preserving the
 * `{ export, ok: true }` envelope verbatim (the embedded `progress` carries its
 * own `ok`, as the live helper returns it).
 */
export const exportPrivateAccountData = oc
  .route({
    method: "POST",
    operationId: "exportPrivateAccountData",
    path: "/me/export",
    summary: "Generate the signed-in account's data export",
    tags: ["Me"],
  })
  .output(
    z.object({
      export: z.object({
        account: PublicUserSchema,
        generatedAt: z.string(),
        id: z.string(),
        preferences: UserPreferencesSchema,
        privacyNotes: z.array(z.string()),
        progress: GalaxyProgressSchema,
        savedFindings: z.array(SavedFindingSchema),
        submissions: z.array(PrivateSubmissionSchema),
      }),
      ok: z.literal(true),
    }),
  );

/**
 * `get_private_account_export` → `GET /me/export/{exportId}`
 * (operationId `getPrivateAccountExport`).
 *
 * Fetch a prior export's status by id. A SIGNED-IN read; reuses `getAccountExport`,
 * preserving the `{ export, ok: true }` status envelope and the `export_not_found`/
 * 404 code. `completedAt` is absent until the export completes.
 */
export const getPrivateAccountExport = oc
  .route({
    method: "GET",
    operationId: "getPrivateAccountExport",
    path: "/me/export/{exportId}",
    summary: "Get a prior data export's status",
    tags: ["Me"],
  })
  .input(z.object({ exportId: z.string() }))
  .output(
    z.object({
      export: z.object({
        completedAt: z.string().optional(),
        expiresAt: z.string(),
        id: z.string(),
        requestedAt: z.string(),
        status: z.string(),
      }),
      ok: z.literal(true),
    }),
  );

/**
 * `list_private_submissions` → `GET /me/submissions`
 * (operationId `listPrivateSubmissions`).
 *
 * The signed-in user's own submissions, newest first. A SIGNED-IN read; reuses
 * `listUserSubmissions`, preserving the `{ ok: true, submissions }` envelope with
 * the user-facing status projection.
 */
export const listPrivateSubmissions = oc
  .route({
    method: "GET",
    operationId: "listPrivateSubmissions",
    path: "/me/submissions",
    summary: "List the signed-in user's submissions",
    tags: ["Me"],
  })
  .output(z.object({ ok: z.literal(true), submissions: z.array(PrivateSubmissionSchema) }));

/** The `me` domain's ops, merged into the root contract by `./index.ts`. */
export const meContract = {
  delete_private_account: deletePrivateAccount,
  export_private_account_data: exportPrivateAccountData,
  get_current_private_user: getCurrentPrivateUser,
  get_private_account_export: getPrivateAccountExport,
  get_private_mutation_token: getPrivateMutationToken,
  list_private_submissions: listPrivateSubmissions,
  update_private_profile: updatePrivateProfile,
};
