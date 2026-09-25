import { oc } from "@orpc/contract";
import * as z from "zod";
import { RadioNowPlayingSchema, TrackListItemSchema } from "./_shared";

export const getRandomRadioTrack = oc
  .route({
    method: "GET",
    operationId: "getRandomRadioTrack",
    path: "/radio/random",
    summary: "Get one random radio-eligible finding (squared video + observation)",
    tags: ["Radio"],
  })
  .output(z.object({ ok: z.literal(true), track: TrackListItemSchema }));

export const getRadioNowPlaying = oc
  .route({
    method: "GET",
    operationId: "getRadioNowPlaying",
    path: "/radio/now-playing",
    summary: "The server-authoritative now-playing slot on the shared schedule",
    tags: ["Radio"],
  })
  .output(z.object({ nowPlaying: RadioNowPlayingSchema, ok: z.literal(true) }));

export const radioContract = {
  get_radio_now_playing: getRadioNowPlaying,
  get_random_radio_track: getRandomRadioTrack,
};
