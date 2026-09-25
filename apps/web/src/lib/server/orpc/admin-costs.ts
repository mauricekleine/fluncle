import { insertCostEvents } from "../costs";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

export function adminCostsHandlers(os: Implementer) {
  const recordCostHandler = os.record_cost.use(adminAuth).handler(async ({ input }) => {
    try {
      const inserted = await insertCostEvents(input);

      return { inserted, ok: true as const };
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    record_cost: recordCostHandler,
  };
}
