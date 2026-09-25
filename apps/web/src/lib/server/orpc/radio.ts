import { ORPCError } from "@orpc/server";
import { type TrackListItem } from "@fluncle/contracts";
import { resolveRadioSlot, totalLoopDurationMs } from "../../radio-schedule";
import { isGalaxyMapFullyNamed } from "../galaxies-map";
import {
  getRadioEligibleTracks,
  getRadioScheduleAnchor,
  getRadioScheduleFingerprint,
  getRandomRadioTrack,
  getTrackByIdOrLogId,
  toPublicTrackListItem,
} from "../tracks";
import { apiFault, type Implementer } from "./_shared";

function gateGalaxy(track: TrackListItem, fullyNamed: boolean): TrackListItem {
  const publicTrack = toPublicTrackListItem(track);

  return fullyNamed ? publicTrack : { ...publicTrack, galaxy: undefined };
}

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

      return { ok: true, track: gateGalaxy(track, await isGalaxyMapFullyNamed()) } as const;
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

      const [currentTrack, nextTrack] = await Promise.all([
        getTrackByIdOrLogId(slot.current.trackId),
        getTrackByIdOrLogId(slot.next.trackId),
      ]);

      if (!currentTrack) {
        throw notFound();
      }

      const fullyNamed = await isGalaxyMapFullyNamed();

      return {
        nowPlaying: {
          currentTrack: gateGalaxy(currentTrack, fullyNamed),

          nextTrack:
            nextTrack && nextTrack.trackId !== currentTrack.trackId
              ? gateGalaxy(nextTrack, fullyNamed)
              : undefined,
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
