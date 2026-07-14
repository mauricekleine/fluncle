// The `admin-observations` domain router — the observation echo gate's ledger made visible,
// plus the authoring read the on-box observation sweep needs. The spoken sibling of
// `admin-notes`. See docs/agents/observation-agent.md.
//
//   - `list_observation_neighbours` — `adminAuth` (agent-allowed read): the neighbourhood's
//     stored scripts, the SPENT moves the box author routes around.
//   - `list_observation_rejections` — `adminAuth` (agent-allowed read): the held scripts + dials.
//   - `resolve_observation_rejection` — `adminAuth` + `operatorGuard` (OPERATOR): the ruling.
//     Accepting spends a Cartesia render, so the box's agent token 403s.
//   - `update_observation_gate` — `adminAuth` + `operatorGuard` (OPERATOR): retune the dials.

import { observationNeighbours } from "../observation-neighbours";
import {
  getObservationEchoThresholds,
  listObservationRejections,
  resolveObservationRejection,
  setObservationEchoThresholds,
} from "../observation-rejections";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { apiFault, type Implementer, parseLimit, requireTrack } from "./_shared";

/** Build the `admin-observations` domain's handlers. */
export function adminObservationsHandlers(os: Implementer) {
  // GET /admin/tracks/{trackId}/observation-neighbours — `adminAuth` (agent-allowed read): the
  // sonic neighbourhood's stored observation scripts, the fuel the box author routes around and
  // the same set the echo gate re-reads. `requireTrack` resolves a Log ID to the trackId the
  // neighbourhood reads by (and 404s a catalogue/unknown track — Fluncle only speaks of findings).
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

  // GET /admin/observation-rejections — `adminAuth`: the held observations + the gate's dials.
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

  // POST /admin/observation-rejections/{id}/resolve — OPERATOR: render the held script or bin it.
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

  // PATCH /admin/observation-gate — OPERATOR: retune the echo gate. A flip, not a deploy.
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
