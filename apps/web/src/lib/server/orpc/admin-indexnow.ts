import { submitIndexNowCatalogue, walkIndexNowCatalogue } from "../indexnow-catalogue";
import { IndexNowFailed } from "../indexnow";
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
        return {
          ...(await submitIndexNowCatalogue(input.dryRun ?? false)),
          ok: true,
          phase: "submit" as const,
        };
      } catch (error) {
        if (input.phase === "submit" && error instanceof IndexNowFailed) {
          return {
            due: error.due ?? null,
            error: String(error.cause),
            ok: false,
            phase: "submit" as const,
            status: error.status ?? null,
            submitted: error.submitted ?? 0,
          };
        }
        throw apiFault(error);
      }
    }),
  };
}
