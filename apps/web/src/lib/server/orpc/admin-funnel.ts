import { getFunnel, recordCatalogueSnapshot } from "../funnel";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

export function adminFunnelHandlers(os: Implementer) {
  const recordCatalogueSnapshotHandler = os.record_catalogue_snapshot
    .use(adminAuth)
    .handler(async () => {
      try {
        const { backfilledDays, snapshot } = await recordCatalogueSnapshot();

        return { backfilledDays, ok: true as const, snapshot };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const getFunnelHandler = os.get_funnel.use(adminAuth).handler(async ({ input }) => {
    try {
      const parsed = input.windowDays ? Number.parseInt(input.windowDays, 10) : undefined;
      const windowDays = parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;

      return await getFunnel(windowDays);
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    get_funnel: getFunnelHandler,
    record_catalogue_snapshot: recordCatalogueSnapshotHandler,
  };
}
