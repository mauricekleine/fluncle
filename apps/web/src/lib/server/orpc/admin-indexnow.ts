import {
  ackIndexNowCatalogue,
  claimIndexNowCatalogue,
  walkIndexNowCatalogue,
} from "../indexnow-catalogue";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

export function adminIndexNowHandlers(os: Implementer) {
  return {
    submit_indexnow: os.submit_indexnow.use(adminAuth).handler(async ({ input }) => {
      try {
        if (input.phase === "walk") {
          return {
            ...(await walkIndexNowCatalogue(input.cursor)),
            ok: true as const,
            phase: "walk" as const,
          };
        }
        if (input.phase === "claim") {
          return {
            ...(await claimIndexNowCatalogue(input.limit)),
            ok: true as const,
            phase: "claim" as const,
          };
        }
        return {
          ...(await ackIndexNowCatalogue(input.versions)),
          ok: true as const,
          phase: "ack" as const,
        };
      } catch (error) {
        throw apiFault(error);
      }
    }),
  };
}
