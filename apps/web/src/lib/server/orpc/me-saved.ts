import { ORPCError } from "@orpc/server";
import { deleteSavedFinding, listSavedFindings, saveFinding } from "../account-data";
import { privateUserAuth, privateUserMutation } from "../orpc-auth";
import { apiFault, type Implementer, responseFault } from "./_shared";

export function meSavedHandlers(os: Implementer) {
  const listSaved = os.list_private_saved_findings
    .use(privateUserAuth)
    .handler(async ({ context }) => {
      try {
        return await listSavedFindings(context.user);
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  const saveFindingHandler = os.save_private_finding
    .use(privateUserMutation({ action: "account.saved.write", limit: 90 }))
    .handler(async ({ context, input }) => {
      try {
        const result = await saveFinding(context.user, input);

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

  const unsaveFinding = os.unsave_private_finding
    .use(privateUserMutation({ action: "account.saved.delete", limit: 90 }))
    .handler(async ({ context, input }) => {
      try {
        const result = await deleteSavedFinding(context.user, input.trackId);

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
    list_private_saved_findings: listSaved,
    save_private_finding: saveFindingHandler,
    unsave_private_finding: unsaveFinding,
  };
}
