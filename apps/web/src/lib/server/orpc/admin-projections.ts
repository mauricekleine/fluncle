// Operator-only projection control plane. Reads return aggregate operational evidence only; writes
// are fixed-target, bounded steps and never accept SQL, table names, or database coordinates.

import { getDb } from "../db";
import {
  advanceProjectionFor,
  getProjectionStatusFor,
  setProjectionCutoverFor,
} from "../projection-operations";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { ApiError } from "../spotify";
import { type Implementer, toFault } from "./_shared";

export function adminProjectionHandlers(os: Implementer) {
  const getProjectionStatusHandler = os.get_projection_status
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async () => {
      try {
        return { ok: true as const, status: await getProjectionStatusFor(await getDb()) };
      } catch (error) {
        throw toFault(error);
      }
    });

  const advanceProjectionHandler = os.advance_projection
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const result = await advanceProjectionFor(await getDb(), input);
        return { ...input, ...result, ok: true as const };
      } catch (error) {
        if (
          error instanceof Error &&
          (/projection audit requires/.test(error.message) || /digest mismatch/.test(error.message))
        ) {
          throw toFault(new ApiError("projection_step_conflict", error.message, 409));
        }
        throw toFault(error);
      }
    });

  const setProjectionCutoverHandler = os.set_projection_cutover
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const status = await setProjectionCutoverFor(await getDb(), input);
        const enabled =
          input.target === "crawl_due_work"
            ? status.cutovers.crawlDueWork
            : input.target === "public_projections"
              ? status.cutovers.publicProjections
              : status.cutovers.trackDueWork;
        return { enabled, ok: true as const, status, target: input.target };
      } catch (error) {
        if (error instanceof Error && /not converged/.test(error.message)) {
          throw toFault(new ApiError("projection_not_ready", error.message, 409));
        }
        throw toFault(error);
      }
    });

  return {
    advance_projection: advanceProjectionHandler,
    get_projection_status: getProjectionStatusHandler,
    set_projection_cutover: setProjectionCutoverHandler,
  };
}
