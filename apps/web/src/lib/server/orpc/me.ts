// The `me` domain router module — the core of the `/me` private-user tier (the
// logged-in user's own account). Implements the seven ops off the shared
// implementer the root (../orpc.ts) hands in, each lifted onto the private-user
// auth tier (../orpc-auth). The Galaxy-progress and saved-findings slices are in
// ./me-galaxy.ts / ./me-saved.ts to keep each module small.
//
// Auth-tier map (matching each live route's preamble exactly):
//   - get_current_private_user  — NO tier. The live GET /me returns user-or-null
//                                 (`meResponse`), it does not 401.
//   - get_private_mutation_token — `privateUserAuth` (signed-in read).
//   - update_private_profile     — `privateUserMutation` (CSRF + account.profile/10).
//   - delete_private_account     — `privateUserMutation` (CSRF + account.delete/2, 24h).
//   - export_private_account_data— `privateUserMutation` (CSRF + account.export/3, 24h).
//   - get_private_account_export — `privateUserAuth` (signed-in read).
//   - list_private_submissions   — `privateUserAuth` (signed-in read).

import { ORPCError } from "@orpc/server";
import {
  deleteAccount,
  exportAccountData,
  getAccountExport,
  listUserSubmissions,
  meResponse,
  updatePrivateUsername,
} from "../account-data";
import { privateUserAuth, privateUserMutation } from "../orpc-auth";
import { createCsrfToken } from "../public-auth";
import { apiFault, type Implementer, responseFault } from "./_shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build the `me` domain's handlers. Each catch re-throws a deliberate `ORPCError`
 * (auth/CSRF/business faults) as-is so the rails encoder keeps its exact
 * code/status; only an unexpected fault is wrapped by `apiFault` into the legacy
 * 500. Helpers that return a `jsonError` Response on failure are lifted via
 * `responseFault` so the legacy `{ code, message, ok: false }` body is exact.
 */
export function meHandlers(os: Implementer) {
  // GET /me — the current session, user-or-null. No auth tier; never 401s.
  const getCurrentUser = os.get_current_private_user.handler(async ({ context }) => {
    try {
      return await meResponse(context.request);
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  // GET /me/csrf — issue the mutation token for the signed-in user.
  const getMutationToken = os.get_private_mutation_token
    .use(privateUserAuth)
    .handler(async ({ context }) => {
      try {
        return { csrfToken: createCsrfToken(context.user), ok: true } as const;
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  // PATCH /me/profile — set username/display name.
  const updateProfile = os.update_private_profile
    .use(privateUserMutation({ action: "account.profile", limit: 10 }))
    .handler(async ({ context, input }) => {
      try {
        const result = await updatePrivateUsername(context.user, input);

        if (result instanceof Response) {
          throw await responseFault(result);
        }

        return result;
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  // POST /me/delete — irreversibly delete the account (daily window).
  const deleteAccountHandler = os.delete_private_account
    .use(privateUserMutation({ action: "account.delete", limit: 2, windowMs: DAY_MS }))
    .handler(async ({ context }) => {
      try {
        return await deleteAccount(context.user);
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  // POST /me/export — generate the data export (daily window).
  const exportData = os.export_private_account_data
    .use(privateUserMutation({ action: "account.export", limit: 3, windowMs: DAY_MS }))
    .handler(async ({ context }) => {
      try {
        return await exportAccountData(context.user);
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  // GET /me/export/{exportId} — fetch a prior export's status.
  const getExport = os.get_private_account_export
    .use(privateUserAuth)
    .handler(async ({ context, input }) => {
      try {
        const result = await getAccountExport(context.user, input.exportId);

        if (result instanceof Response) {
          throw await responseFault(result);
        }

        return result;
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  // GET /me/submissions — the signed-in user's own submissions.
  const listSubmissions = os.list_private_submissions
    .use(privateUserAuth)
    .handler(async ({ context }) => {
      try {
        return await listUserSubmissions(context.user);
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  return {
    delete_private_account: deleteAccountHandler,
    export_private_account_data: exportData,
    get_current_private_user: getCurrentUser,
    get_private_account_export: getExport,
    get_private_mutation_token: getMutationToken,
    list_private_submissions: listSubmissions,
    update_private_profile: updateProfile,
  };
}
