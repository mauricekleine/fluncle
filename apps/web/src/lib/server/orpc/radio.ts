// The `radio` domain router module. Implements the cycling-station read op (RFC
// Unit B) off the shared implementer the root (../orpc.ts) hands in. A future
// wave adds an op here and one spread line in the root — no other domain's file
// is touched.

import { ORPCError } from "@orpc/server";
import { resolveRadioSlot, totalLoopDurationMs } from "../../radio-schedule";
import {
  getRadioEligibleTracks,
  getRadioScheduleAnchor,
  getRadioScheduleFingerprint,
  getRandomRadioTrack,
  getTrackByIdOrLogId,
} from "../tracks";
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

  const notFound = () =>
    new ORPCError("NOT_FOUND", {
      data: { apiCode: "track_not_found", apiMessage: "No radio-eligible tracks found" },
      message: "No radio-eligible tracks found",
    });

  // The server-authoritative now-playing slot on the shared loop. The eligible set
  // is read deterministically (found-order); the stored epoch is read+rolled (a
  // self-heal at the next boundary on a changed set); the modulo math resolves the
  // current slot + offset. `currentTrack`/`nextTrack` are hydrated to full list
  // items so the page renders identical metadata to the random read. The server
  // timestamp rides along for the client's NTP-lite skew. An empty set is the
  // same `track_not_found` 404 the random read uses (the page's quiet-sector copy).
  const getRadioNowPlayingHandler = os.get_radio_now_playing.handler(async () => {
    try {
      const entries = await getRadioEligibleTracks();
      const version = await getRadioScheduleFingerprint();
      const loopMs = totalLoopDurationMs(entries);
      const nowMs = Date.now();
      const anchor = await getRadioScheduleAnchor(version, loopMs, nowMs);
      const slot = resolveRadioSlot(entries, anchor.epochMs, nowMs);

      if (!slot) {
        throw notFound();
      }

      // Hydrate the two scheduled slots to full list items (the lean schedule
      // query carries only the clock fields). The eligibility predicate guarantees
      // the rows still exist; a vanished row (a delete between reads) 404s rather
      // than serving a partial slot — the client resyncs, it never random-skips.
      const [currentTrack, nextTrack] = await Promise.all([
        getTrackByIdOrLogId(slot.current.trackId),
        getTrackByIdOrLogId(slot.next.trackId),
      ]);

      if (!currentTrack) {
        throw notFound();
      }

      return {
        nowPlaying: {
          currentTrack,
          // Omit a self-referential next on a single-finding loop (it's the same
          // finding looping; there is no distinct preload target).
          nextTrack:
            nextTrack && nextTrack.trackId !== currentTrack.trackId ? nextTrack : undefined,
          offsetMs: slot.offsetMs,
          scheduleVersion: anchor.version,
          serverEpochMs: nowMs,
          totalLoopDurationMs: loopMs,
          trackCount: entries.length,
        },
        ok: true,
      } as const;
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  return {
    get_radio_now_playing: getRadioNowPlayingHandler,
    get_random_radio_track: getRandomRadioTrackHandler,
  };
}
