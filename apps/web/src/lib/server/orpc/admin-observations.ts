import { observationNeighbours } from "../observation-neighbours";
import {
  getObservationEchoThresholds,
  listObservationRejections,
  resolveObservationRejection,
  setObservationEchoThresholds,
} from "../observation-rejections";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, type Implementer, parseLimit, requireTrack } from "./_shared";

export function adminObservationsHandlers(os: Implementer) {
  const listObservationNeighboursHandler = os.list_observation_neighbours
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const track = await requireTrack(input.trackId);
        const limit = parseLimit(input.limit, 6, 12);
        const neighbours = await observationNeighbours(track.trackId, limit);

        return { neighbours, ok: true } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  const listObservationRejectionsHandler = os.list_observation_rejections
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const open = input.open !== "false";
        const [rejections, gate] = await Promise.all([
          listObservationRejections({
            open,
            ...(input.trackId ? { trackId: input.trackId } : {}),
          }),
          getObservationEchoThresholds(),
        ]);

        return { gate, ok: true, rejections } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  const resolveObservationRejectionHandler = os.resolve_observation_rejection
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { rejection, skipped } = await resolveObservationRejection(
          input.id,
          input.resolution,
        );

        return { ok: true, rejection, skipped } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  const updateObservationGateHandler = os.update_observation_gate
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const gate = await setObservationEchoThresholds({
          ...(input.maxOverlap !== undefined ? { maxOverlap: input.maxOverlap } : {}),
          ...(input.minPhraseWords !== undefined ? { minPhraseWords: input.minPhraseWords } : {}),
        });

        return { gate, ok: true } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    list_observation_neighbours: listObservationNeighboursHandler,
    list_observation_rejections: listObservationRejectionsHandler,
    resolve_observation_rejection: resolveObservationRejectionHandler,
    update_observation_gate: updateObservationGateHandler,
  };
}
