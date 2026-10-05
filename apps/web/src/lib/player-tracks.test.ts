import { describe, expect, it } from "vitest";
import { listenOutLink, trackListenLinks } from "./listen-out";
import { similarSearchHref, toQueueTrack } from "./player-tracks";

describe("similarSearchHref — where 'Similar tracks' goes", () => {
  it("opens the sonic view keyed by the track id, so a seed never resolves to a namesake", () => {
    expect(similarSearchHref({ artists: ["Netsky"], id: "mb_1234-abcd", title: "Rio" })).toBe(
      "/search?like=mb_1234-abcd",
    );
  });

  it("falls back to the worded phrase for a finding-only caller keyed by its coordinate", () => {
    expect(similarSearchHref({ artists: ["1991"], id: "024.7.2R", title: "Nine Clouds" })).toBe(
      "/search?q=tracks%20that%20sound%20like%201991%20%E2%80%94%20Nine%20Clouds",
    );
  });
});

describe("toQueueTrack: the services the player can send a listener to", () => {
  const finding = {
    artists: ["Calibre"],
    logId: "024.7.2R",
    spotifyUrl: "https://open.spotify.com/track/abc",
    title: "Mr Maze",
    trackId: "t-1",
  };

  it("carries a finding's Apple Music link beside its Spotify one", () => {
    const queued = toQueueTrack({
      ...finding,
      appleMusicUrl: "https://music.apple.com/album/x?i=1",
    });

    expect(trackListenLinks(queued).map((link) => link.kind)).toEqual(["spotify", "apple"]);
  });

  it("keeps a track page's full listen band when the caller hands it over", () => {
    const queued = toQueueTrack({
      ...finding,
      appleMusicUrl: "https://music.apple.com/album/x?i=1",
      listen: [{ href: "https://www.deezer.com/track/42", kind: "deezer" }],
    });

    expect(trackListenLinks(queued).map((link) => link.kind)).toEqual(["spotify", "deezer"]);
  });

  it("gives a catalogue track without Spotify its next listening service", () => {
    const queued = toQueueTrack({
      artists: ["Calibre"],
      listen: [{ href: "https://www.youtube.com/watch?v=v1", kind: "youtube" }],
      title: "Mr Maze",
      trackId: "mb_1",
    });

    expect(listenOutLink(queued)?.kind).toBe("youtube");
  });
});
