import { publicApiGet } from "../api";
import { type RecentTrack } from "./recent";

type RandomTrackResponse = {
  ok: true;
  track: RecentTrack;
};

export async function randomCommand(): Promise<RecentTrack> {
  const response = await publicApiGet<RandomTrackResponse>("/api/tracks/random");

  return response.track;
}
