import { ORPCError } from "@orpc/server";
import { getUserPreferences, updateUserPreferences } from "../account-data";
import { privateUserAuth, privateUserMutation } from "../orpc-auth";
import { apiFault, type Implementer, responseFault } from "./_shared";

export function mePreferencesHandlers(os: Implementer) {
  const getPreferences = os.get_private_preferences
    .use(privateUserAuth)
    .handler(async ({ context }) => {
      try {
        return await getUserPreferences(context.user);
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  const updatePreferences = os.update_private_preferences
    .use(privateUserMutation({ action: "account.preferences.update", limit: 90 }))
    .handler(async ({ context, input }) => {
      try {
        const result = await updateUserPreferences(context.user, input);

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

  return {
    get_private_preferences: getPreferences,
    update_private_preferences: updatePreferences,
  };
}
