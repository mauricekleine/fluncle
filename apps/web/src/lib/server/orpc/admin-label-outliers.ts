import { ORPCError } from "@orpc/server";
import {
  LABEL_OUTLIER_INPUTS_DEFAULT_PAGE,
  LABEL_OUTLIER_INPUTS_MAX_PAGE,
} from "@fluncle/contracts/orpc";
import {
  acknowledgeLabelOutlierAlerts,
  InvalidLabelOutlierInputsCursor,
  LabelOutlierRunRejected,
  listLabelOutlierInputsPage,
  listLabelOutliers,
  recordLabelOutliers,
  setLabelOutliersDismissed,
} from "../label-outliers";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, type Implementer, parseLimit } from "./_shared";

export function adminLabelOutliersHandlers(os: Implementer) {
  const recordLabelOutliersHandler = os.record_label_outliers
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return { ...(await recordLabelOutliers(input)), ok: true } as const;
      } catch (error) {
        if (error instanceof LabelOutlierRunRejected) {
          throw new ORPCError("CONFLICT", {
            data: { apiCode: "label_outlier_run_rejected", apiMessage: error.message },
            message: error.message,
            status: 409,
          });
        }

        throw apiFault(error);
      }
    });

  const acknowledgeLabelOutlierAlertsHandler = os.acknowledge_label_outlier_alerts
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return {
          acknowledged: await acknowledgeLabelOutlierAlerts(input.units),
          ok: true,
        } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  const listLabelOutlierInputsHandler = os.list_label_outlier_inputs
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return {
          ...(await listLabelOutlierInputsPage(
            input.cursor,
            parseLimit(
              input.limit,
              LABEL_OUTLIER_INPUTS_DEFAULT_PAGE,
              LABEL_OUTLIER_INPUTS_MAX_PAGE,
            ),
          )),
          ok: true,
        } as const;
      } catch (error) {
        if (error instanceof InvalidLabelOutlierInputsCursor) {
          throw new ORPCError("BAD_REQUEST", {
            data: { apiCode: "invalid_cursor", apiMessage: error.message },
            message: error.message,
            status: 400,
          });
        }

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
    acknowledge_label_outlier_alerts: acknowledgeLabelOutlierAlertsHandler,
    list_label_outlier_inputs: listLabelOutlierInputsHandler,
    list_label_outliers: listLabelOutliersHandler,
    record_label_outliers: recordLabelOutliersHandler,
    set_label_outliers_dismissed: setLabelOutliersDismissedHandler,
  };
}
