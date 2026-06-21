// The `radio` domain router module. Implements the cycling-station read op (RFC
// Unit B) off the shared implementer the root (../orpc.ts) hands in. A future
// wave adds an op here and one spread line in the root — no other domain's file
// is touched.

import { ORPCError } from "@orpc/server";
import { getRandomRadioTrack } from "../tracks";
import { apiFault, type Implementer } from "./_shared";

/**
 * Build the `radio` domain's handlers. `get_random_radio_track` returns one random
 * RADIO-ELIGIBLE finding (a squared master + an observation — the `getRandomRadioTrack`
 * SQL filter guarantees both), mapped like every other list item, in the
 * `{ ok: true, track }` envelope. An empty eligible set is a 404 carrying the same
 * custom `track_not_found` code/message the random-track read uses, so the rails
 * encoder reproduces the legacy `jsonError` body rather than the generic `not_found`.
 */
export function radioHandlers(os: Implementer) {
  const getRandomRadioTrackHandler = os.get_random_radio_track.handler(async () => {
    try {
      const track = await getRandomRadioTrack();

      if (!track) {
        throw new ORPCError("NOT_FOUND", {
          data: { apiCode: "track_not_found", apiMessage: "No radio-eligible tracks found" },
          message: "No radio-eligible tracks found",
        });
      }

      return { ok: true, track } as const;
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  return { get_random_radio_track: getRandomRadioTrackHandler };
}
