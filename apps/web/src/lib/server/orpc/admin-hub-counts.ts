import { reconcileHubCounts } from "../hub-counts-reconcile";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

export function adminHubCountsHandlers(os: Implementer) {
  const reconcileHubCountsHandler = os.reconcile_hub_counts
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { albums, artists, labels, next, pages, tookMs } = await reconcileHubCounts({
          cursor: input.cursor,
          pageLimit: input.pageLimit,
        });

        return { albums, artists, labels, next, ok: true as const, pages, tookMs };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    reconcile_hub_counts: reconcileHubCountsHandler,
  };
}
