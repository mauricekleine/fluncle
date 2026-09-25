import { getDb } from "../db";
import { rekeyDueWorkQueue, UnknownDueWorkQueueError } from "../due-work-rekey";
import {
  advanceProjectionFor,
  getProjectionStatusFor,
  setProjectionCutoverFor,
} from "../projection-operations";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { ApiError } from "../spotify";
import { type Implementer, toFault } from "./_shared";

const AGENT_REPAIR_TARGETS = new Set([
  "artist_qualification",
  "crawl_due_work",
  "public_aggregates",
  "track_due_work",
]);

export function adminProjectionHandlers(os: Implementer) {
  const getProjectionStatusHandler = os.get_projection_status.use(adminAuth).handler(async () => {
    try {
      return { ok: true as const, status: await getProjectionStatusFor(await getDb()) };
    } catch (error) {
      throw toFault(error);
    }
  });

  const advanceProjectionHandler = os.advance_projection
    .use(adminAuth)
    .handler(async ({ context, input }) => {
      try {
        if (
          context.role !== "operator" &&
          (input.action !== "repair" || !AGENT_REPAIR_TARGETS.has(input.target))
        ) {
          throw new ApiError("forbidden", "This action requires the operator role", 403);
        }
        const result = await advanceProjectionFor(await getDb(), input);
        return {
          action: input.action,
          ...result,
          ok: true as const,
          target: input.target,
        };
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

  const rekeyDueWorkQueueHandler = os.rekey_due_work_queue
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const result = await rekeyDueWorkQueue(await getDb(), {
          apply: input.apply,
          cursor: input.cursor,
          limit: input.limit,
          workKind: input.workKind,
        });
        return { ...result, ok: true as const };
      } catch (error) {
        if (error instanceof UnknownDueWorkQueueError) {
          throw toFault(
            new ApiError(
              "unknown_due_work_queue",
              `${error.message}; queues: ${error.workKinds.join(", ")}`,
              400,
            ),
          );
        }
        throw toFault(error);
      }
    });

  return {
    advance_projection: advanceProjectionHandler,
    get_projection_status: getProjectionStatusHandler,
    rekey_due_work_queue: rekeyDueWorkQueueHandler,
    set_projection_cutover: setProjectionCutoverHandler,
  };
}
