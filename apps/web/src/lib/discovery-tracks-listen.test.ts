import { describe, expect, it } from "vitest";
import { type TrackListItem } from "@fluncle/contracts";
import { discoveryQueueTrack, findingToDiscoveryTrack } from "./discovery-tracks";
import { trackListenLinks } from "./listen-out";

const finding = {
  addedAt: "2026-01-01T00:00:00.000Z",
  addedToSpotify: false,
  appleMusicUrl: "https://music.apple.com/album/x?i=1",
  artists: ["Calibre"],
  logId: "024.7.2R",
  postedToTelegram: false,
  spotifyUrl: "https://open.spotify.com/track/abc",
  title: "Mr Maze",
  trackId: "t-1",
} as TrackListItem;

describe("a finding row offers every service the finding has", () => {
  it("carries Apple Music beside Spotify into the row's queue track", () => {
    const queued = discoveryQueueTrack(findingToDiscoveryTrack(finding));

    expect(trackListenLinks(queued).map((link) => link.kind)).toEqual(["spotify", "apple"]);
  });
});
