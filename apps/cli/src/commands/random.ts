import { type RandomTrackResponse } from "@fluncle/contracts";
import { publicApiGet } from "../api";
import { type RecentTrack } from "./recent";

export async function randomCommand(): Promise<RecentTrack> {
  const response = await publicApiGet<RandomTrackResponse>("/api/v1/tracks/random");

  return response.track;
}
