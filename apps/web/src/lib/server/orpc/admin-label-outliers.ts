import {
  listLabelOutliers,
  recordLabelOutliers,
  setLabelOutliersDismissed,
} from "../label-outliers";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

export function adminLabelOutliersHandlers(os: Implementer) {
  const recordLabelOutliersHandler = os.record_label_outliers
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return { ...(await recordLabelOutliers(input)), ok: true } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  const listLabelOutliersHandler = os.list_label_outliers.use(adminAuth).handler(async () => {
    try {
      return { ...(await listLabelOutliers()), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  const setLabelOutliersDismissedHandler = os.set_label_outliers_dismissed
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return {
          changed: await setLabelOutliersDismissed(input.unitIds, input.dismissed),
          ok: true,
        } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    list_label_outliers: listLabelOutliersHandler,
    record_label_outliers: recordLabelOutliersHandler,
    set_label_outliers_dismissed: setLabelOutliersDismissedHandler,
  };
}
