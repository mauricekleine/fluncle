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

export function meHandlers(os: Implementer) {
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
