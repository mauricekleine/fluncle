import { describe, expect, it } from "vitest";
import { type TrackListItem } from "@fluncle/contracts";
import { findingToDiscoveryTrack, hubEntryToDiscoveryTrack } from "./discovery-tracks";
import { toLeanTrackListItem, type TrackRow } from "./server/tracks";

function finding(similar: boolean | undefined): TrackListItem {
  return {
    addedAt: "2026-01-01T00:00:00.000Z",
    addedToSpotify: false,
    artists: ["Nova Kestrel"],
    durationMs: 200_000,
    logId: "701.1.0A",
    postedToTelegram: false,
    similar,
    spotifyUrl: "https://open.spotify.com/track/x",
    title: "Synthetic Aurora",
    trackId: "t1",
  } as TrackListItem;
}

describe("a finding says whether it has a sound to find similar tracks from", () => {
  it("carries the flag from the row to the discovery row, lit or in the /tracks hub", () => {
    expect(findingToDiscoveryTrack(finding(false)).similar).toBe(false);
    expect(findingToDiscoveryTrack(finding(true)).similar).toBe(true);
    expect(
      hubEntryToDiscoveryTrack({
        artistLinks: [],
        finding: finding(false),
        kind: "finding",
        releaseDate: "2026-01-01",
      }).similar,
    ).toBe(false);
  });

  it("maps the projected sonic_seed column onto the finding DTO", () => {
    const row = (sonicSeed: number) =>
      ({
        added_at: "2026-01-01",
        artists_json: "[]",
        sonic_seed: sonicSeed,
        title: "x",
        track_id: "t",
      }) as unknown as TrackRow;

    expect(toLeanTrackListItem(row(0)).similar).toBe(false);
    expect(toLeanTrackListItem(row(1)).similar).toBe(true);
  });
});
