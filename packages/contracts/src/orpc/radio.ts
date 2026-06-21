// The `radio` domain contract module. Owns the cycling-station read op (RFC Unit
// B — radio.fluncle.com). A future wave adds an op here and one import line in
// `./index.ts`, touching no other domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";
import { TrackListItemSchema } from "./_shared";

/**
 * `get_random_radio_track` → `GET /radio/random` (operationId `getRandomRadioTrack`).
 *
 * One random RADIO-ELIGIBLE finding for the lean-back station. Eligible = the
 * finding carries BOTH a clean square master (`videoSquaredAt` set, so radio can
 * centre-crop it per orientation and draw its own chrome over it — never the old
 * baked-text cut) AND an observation (`observationAudioUrl` set, the only audio
 * radio plays over the silent video). The success body is the standard
 * `{ ok: true, track }` envelope — the same `TrackListItem` every other read
 * returns, carrying the metadata (logId, artist/title, label, releaseDate, bpm,
 * key, vibe x/y + derived galaxy), the `?v`-versioned `observationAudioUrl`, and
 * the `/log` + Spotify links. The page builds the per-orientation silent video
 * URLs from `logId` (media.ts `videoCrop`/`videoAudioStripped`), keeping the
 * contract lean and the orientation choice responsive. An empty eligible set is a
 * 404 — handled by the rails error encoder, not the output schema.
 */
export const getRandomRadioTrack = oc
  .route({
    method: "GET",
    operationId: "getRandomRadioTrack",
    path: "/radio/random",
    summary: "Get one random radio-eligible finding (squared video + observation)",
    tags: ["Radio"],
  })
  .output(z.object({ ok: z.literal(true), track: TrackListItemSchema }));

/** The `radio` domain's ops, merged into the root contract by `./index.ts`. */
export const radioContract = {
  get_random_radio_track: getRandomRadioTrack,
};
