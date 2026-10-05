import { describe, expect, it } from "vitest";
import { classifyDiscoveryHref } from "./discovery-events";
import { listenOutLink, trackListenLinks } from "./listen-out";

const SPOTIFY = "https://open.spotify.com/track/abc";
const APPLE = "https://music.apple.com/album/x?i=1";
const DEEZER = "https://www.deezer.com/track/42";
const BEATPORT = "https://www.beatport.com/track/x/1";
const YOUTUBE = "https://www.youtube.com/watch?v=v1";

describe("trackListenLinks: every service a track can be heard on", () => {
  it("leads with Spotify, then keeps the order the track carries its other services in", () => {
    expect(
      trackListenLinks({
        listen: [
          { href: APPLE, kind: "apple" },
          { href: DEEZER, kind: "deezer" },
        ],
        spotifyUrl: SPOTIFY,
      }).map((link) => link.kind),
    ).toEqual(["spotify", "apple", "deezer"]);
  });

  it("never lists one service twice when the Spotify link also rides the list", () => {
    expect(
      trackListenLinks({
        listen: [
          { href: SPOTIFY, kind: "spotify" },
          { href: APPLE, kind: "apple" },
        ],
        spotifyUrl: SPOTIFY,
      }),
    ).toEqual([
      { href: SPOTIFY, kind: "spotify" },
      { href: APPLE, kind: "apple" },
    ]);
  });

  it("is empty for a track with nowhere to listen", () => {
    expect(trackListenLinks({})).toEqual([]);
  });
});

describe("listenOutLink: the one way out the player offers", () => {
  it("is Spotify when the track has it", () => {
    expect(
      listenOutLink({ listen: [{ href: APPLE, kind: "apple" }], spotifyUrl: SPOTIFY }),
    ).toEqual({ href: SPOTIFY, kind: "spotify" });
  });

  it("falls to the next listening service when Spotify is missing", () => {
    expect(
      listenOutLink({
        listen: [
          { href: BEATPORT, kind: "beatport" },
          { href: YOUTUBE, kind: "youtube" },
        ],
      }),
    ).toEqual({ href: YOUTUBE, kind: "youtube" });
  });

  it("never offers a store as the way to listen", () => {
    expect(listenOutLink({ listen: [{ href: BEATPORT, kind: "beatport" }] })).toBeUndefined();
  });

  it("only offers a service the discovery listener counts as an outbound listen", () => {
    const services = [
      { href: SPOTIFY, kind: "spotify" },
      { href: APPLE, kind: "apple" },
      { href: DEEZER, kind: "deezer" },
      { href: YOUTUBE, kind: "youtube" },
    ] as const;

    for (const service of services) {
      const link = listenOutLink({ listen: [service] });

      expect(link && classifyDiscoveryHref(link.href)?.event).toBe("discovery_outbound");
    }
  });
});
