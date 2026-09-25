import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IdentityAnswer } from "./identity.$key";
import { type IdentityEnvelope, type IdentityRecording } from "@/lib/server/identity-envelope";
import { identityKeyFor, type IdentityPageData } from "./-identity-page-data";

const ROUTE_PATHS = ["/", "/identity", "/identity/$key", "/log/$logId", "/docs/$"];

async function renderPage(data: IdentityPageData): Promise<string> {
  const rootRoute = createRootRoute({ component: () => <IdentityAnswer data={data} /> });
  const children = ROUTE_PATHS.map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path }),
  );
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren(children),
  });

  await router.load();

  return renderToString(<RouterProvider router={router} />);
}

function recording(overrides: Partial<IdentityRecording> = {}): IdentityRecording {
  return {
    artists: ["Calibre"],
    certified: false,
    identifiers: {
      isrc: { state: "unattempted" },
      mbRecordingId: { state: "unattempted" },
    },
    links: {
      appleMusic: { state: "unattempted" },
      beatport: { state: "unattempted" },
      deezer: { state: "unattempted" },
      discogs: { state: "unattempted" },
      spotify: { state: "unattempted" },
      tidal: { state: "unsupported" },
      youtube: { state: "unattempted" },
    },
    logId: null,
    relation: "canonical",
    title: "Mr Maverick",
    trackId: "track-1",
    ...overrides,
  };
}

function envelope(recordings: IdentityRecording[]): IdentityEnvelope {
  return {
    meta: {
      asOf: "2026-07-29T00:00:00.000Z",
      attribution: "Recording identifiers include data from MusicBrainz (musicbrainz.org).",
      contact: "hey@fluncle.com",
    },
    recordings,
  };
}

function found(recordings: IdentityRecording[]): IdentityPageData {
  return { envelope: envelope(recordings), key: "GBXXX0000000", kind: "isrc", status: "found" };
}

describe("the identity answer", () => {
  it("renders a certified recording lit: its coordinate, and the link home", async () => {
    const html = await renderPage(
      found([
        recording({
          certified: true,
          links: {
            appleMusic: { state: "unattempted" },
            beatport: { state: "unattempted" },
            deezer: { state: "unattempted" },
            discogs: { state: "unattempted" },
            spotify: {
              state: "verified",
              url: "https://www.fluncle.com/out/spotify/track-1",
              value: "abc",
              verification: {
                at: "2026-07-01T00:00:00.000Z",
                atMeaning: "verified",
                method: "publish",
                source: null,
              },
            },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
          logId: "004.7.2I",
        }),
      ]),
    );

    expect(html).toContain("Calibre — Mr Maverick");
    expect(html).toContain('href="/log/004.7.2I"');
    expect(html).toContain("fluncle://004.7.2I");
    expect(html).not.toContain("identity-title--unlit");

    expect(html).not.toContain("log-index-intro");

    expect(html).toContain('href="https://www.fluncle.com/out/spotify/track-1"');
    expect(html).toContain("Listen on Spotify");

    expect(html).toContain("from Spotify&#x27;s own record · confirmed Jul 1, 2026");
  });

  it("renders an uncertified recording unlit: no coordinate, no link home, no noun for the tier", async () => {
    const html = await renderPage(found([recording()]));

    expect(html).toContain("Calibre — Mr Maverick");
    expect(html).toContain("identity-title--unlit");

    expect(html).not.toContain("fluncle://");
    expect(html).not.toContain('href="/log/');

    expect(html.toLowerCase()).not.toContain("catalogue");
    expect(html.toLowerCase()).not.toContain("uncertified");
  });

  it("renders only the covered platforms, never a not-covered row", async () => {
    const html = await renderPage(found([recording()]));

    expect(html).not.toContain("Tidal");
    expect(html).not.toContain("Not covered");

    for (const label of [
      "ISRC",
      "MusicBrainz",
      "Spotify",
      "Apple Music",
      "Deezer",
      "Discogs",
      "Beatport",
      "YouTube",
    ]) {
      expect(html).toContain(`<dt>${label}</dt>`);
    }
  });

  it("carries a held Beatport link out as a BUY, never a listen", async () => {
    const html = await renderPage(
      found([
        recording({
          links: {
            appleMusic: { state: "unattempted" },
            beatport: {
              state: "verified",
              url: "https://www.beatport.com/track/pluto/19385810",
              value: "https://www.beatport.com/track/pluto/19385810",
              verification: {
                at: "2026-07-30T00:00:00.000Z",
                atMeaning: "verified",
                method: "isrc",
                source: null,
              },
            },
            deezer: { state: "unattempted" },
            discogs: { state: "unattempted" },
            spotify: { state: "unattempted" },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    expect(html).toContain('href="https://www.beatport.com/track/pluto/19385810"');
    expect(html).toContain("Buy on Beatport");
    expect(html).not.toContain("Listen on Beatport");

    expect(html).toContain("matched by ISRC · confirmed Jul 30, 2026");
  });

  it("carries a held YouTube link out as a WATCH, under the fingerprint that won it", async () => {
    const html = await renderPage(
      found([
        recording({
          links: {
            appleMusic: { state: "unattempted" },
            beatport: { state: "unattempted" },
            deezer: { state: "unattempted" },
            discogs: { state: "unattempted" },
            spotify: { state: "unattempted" },
            tidal: { state: "unsupported" },
            youtube: {
              state: "verified",
              url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
              value: "dQw4w9WgXcQ",
              verification: {
                at: "2026-07-31T00:00:00.000Z",
                atMeaning: "verified",
                method: "fingerprint",
                source: null,
              },
            },
          },
        }),
      ]),
    );

    expect(html).toContain('href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"');
    expect(html).toContain("Watch on YouTube");
    expect(html).not.toContain("Listen on YouTube");
    expect(html).toContain("matched by audio fingerprint · confirmed Jul 31, 2026");
  });

  it("says nothing at all about a YouTube id it has not cleared", async () => {
    const html = await renderPage(found([recording()]));

    expect(html).toContain("<dt>YouTube</dt>");
    expect(html).not.toContain("youtube.com/watch");
    expect(html).not.toContain("Watch on YouTube");
  });

  it("says a Beatport miss without promising another look", async () => {
    const html = await renderPage(
      found([
        recording({
          links: {
            appleMusic: { state: "unattempted" },
            beatport: {
              attempts: 1,
              cap: null,
              lastAttemptedAt: "2026-07-30T00:00:00.000Z",
              retry: "single-shot",
              state: "absent",
              terminal: null,
            },
            deezer: { state: "unattempted" },
            discogs: { state: "unattempted" },
            spotify: { state: "unattempted" },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    expect(html).toContain("Not found · checked Jul 30, 2026");
    expect(html).not.toContain("will be checked again");
    expect(html).not.toContain("retired");
  });

  it("carries a held Deezer link out, with the rung that won it", async () => {
    const html = await renderPage(
      found([
        recording({
          links: {
            appleMusic: { state: "unattempted" },
            beatport: { state: "unattempted" },
            deezer: {
              state: "verified",
              url: "https://www.deezer.com/track/3135556",
              value: "3135556",
              verification: {
                at: "2026-07-30T00:00:00.000Z",
                atMeaning: "verified",
                method: "search",
                source: null,
              },
            },
            discogs: { state: "unattempted" },
            spotify: { state: "unattempted" },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    expect(html).toContain('href="https://www.deezer.com/track/3135556"');
    expect(html).toContain("Listen on Deezer");
    expect(html).toContain("matched by artist, title, and length · confirmed Jul 30, 2026");
  });

  it("says a Deezer miss was checked, never confirmed, and promises no second look", async () => {
    const html = await renderPage(
      found([
        recording({
          links: {
            appleMusic: { state: "unattempted" },
            beatport: { state: "unattempted" },
            deezer: {
              attempts: 1,
              cap: null,
              lastAttemptedAt: "2026-07-30T00:00:00.000Z",
              retry: "single-shot",
              state: "absent",
              terminal: null,
            },
            discogs: { state: "unattempted" },
            spotify: { state: "unattempted" },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    expect(html).toContain("Not found · checked Jul 30, 2026");
    expect(html).not.toContain("confirmed Jul 30, 2026");
    expect(html).not.toContain("will be checked again");
    expect(html).not.toContain("retired");

    expect(html).not.toContain("Listen on Deezer");
  });

  it("says every negative out loud rather than leaving a gap", async () => {
    const html = await renderPage(
      found([
        recording({
          identifiers: {
            isrc: {
              cap: null,
              lastAttemptedAt: "2026-07-12T00:00:00.000Z",
              retry: "recheckable",
              state: "absent",
              terminal: null,
            },
            mbRecordingId: {
              cap: null,
              lastAttemptedAt: "2026-07-18T00:00:00.000Z",
              retry: "single-shot",
              state: "absent",
              terminal: true,
            },
          },
          links: {
            appleMusic: { state: "unattempted" },
            beatport: { state: "unattempted" },
            deezer: { state: "unattempted" },
            discogs: {
              attempts: 2,
              cap: null,
              lastAttemptedAt: "2026-07-18T00:00:00.000Z",
              retry: "single-shot",
              state: "absent",
              terminal: null,
            },
            spotify: { reason: "attempt-cap-reached", state: "refused" },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    expect(html).toContain("Not found · last checked Jul 12, 2026 · will be checked again");

    expect(html).toContain("Not found · checked Jul 18, 2026 · retired");

    expect(html).toContain("Not found · checked 2 times, last Jul 18, 2026");

    expect(html).toContain("Not found · checked as many times as allowed · retired");
    expect(html).toContain("Not checked yet");
  });

  it("keeps a capped miss under its ceiling instead of retiring it early", async () => {
    const html = await renderPage(
      found([
        recording({
          links: {
            appleMusic: { state: "unattempted" },
            beatport: { state: "unattempted" },
            deezer: { state: "unattempted" },
            discogs: { state: "unattempted" },
            spotify: {
              cap: 6,
              lastAttemptedAt: "2026-07-12T00:00:00.000Z",
              retry: "capped",
              state: "absent",
              terminal: false,
            },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    expect(html).toContain(
      "Not found · last checked Jul 12, 2026 · will be checked again, up to 6 times in all",
    );
    expect(html).not.toContain("retired");
    expect(html).not.toContain("times, last");
  });

  it("keeps the method fragment off the two words the date fragment owns", async () => {
    const html = await renderPage(
      found([
        recording({
          identifiers: {
            isrc: { state: "unattempted" },
            mbRecordingId: {
              state: "verified",
              url: "https://musicbrainz.org/recording/0f7d",
              value: "0f7d",
              verification: {
                at: "2026-07-12T00:00:00.000Z",
                atMeaning: "attempted",
                method: "pk-derived",
                source: null,
              },
            },
          },
          links: {
            appleMusic: { state: "unattempted" },
            beatport: { state: "unattempted" },
            deezer: { state: "unattempted" },
            discogs: { state: "unattempted" },
            spotify: {
              state: "verified",
              url: "https://www.fluncle.com/out/spotify/track-1",
              value: "abc",
              verification: {
                at: "2026-07-01T00:00:00.000Z",
                atMeaning: "verified",
                method: "operator",
                source: null,
              },
            },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    expect(html).toContain("the id it arrived under · checked Jul 12, 2026");
    expect(html).toContain("set by hand · confirmed Jul 1, 2026");
    expect(html).not.toContain("confirmed by hand");

    expect(html).not.toContain("from MusicBrainz");
  });

  it("says an unrecorded provenance and an unsearchable credit without either going vague", async () => {
    const html = await renderPage(
      found([
        recording({
          identifiers: {
            isrc: {
              state: "verified",
              value: "GBXXX0000000",
              verification: {
                at: "2026-07-12T00:00:00.000Z",
                atMeaning: "attempted",
                method: "unknown-legacy",
                source: null,
              },
            },
            mbRecordingId: { state: "unattempted" },
          },
          links: {
            appleMusic: { state: "unattempted" },
            beatport: { state: "unattempted" },
            deezer: { state: "unattempted" },
            discogs: { state: "unattempted" },
            spotify: { reason: "credit-not-an-identity", state: "refused" },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    expect(html).toContain('<span class="identity-provenance">checked Jul 12, 2026</span>');
    expect(html).toContain("GBXXX0000000");
    expect(html).toContain("Not eligible · no artist credit to search on");
  });

  it("renders an Apple Music link the API withholds, under its ratified label", async () => {
    const html = await renderPage(
      found([
        recording({
          links: {
            appleMusic: {
              state: "verified",
              url: "https://music.apple.com/us/album/x/1?i=2",
              value: "https://music.apple.com/us/album/x/1?i=2",
              verification: {
                at: "2026-05-01T00:00:00.000Z",
                atMeaning: "verified",
                method: "isrc",
                source: null,
              },
            },
            beatport: { state: "unattempted" },
            deezer: { state: "unattempted" },
            discogs: { state: "unattempted" },
            spotify: { state: "unattempted" },
            tidal: { state: "unsupported" },
            youtube: { state: "unattempted" },
          },
        }),
      ]),
    );

    expect(html).toContain('href="https://music.apple.com/us/album/x/1?i=2"');

    expect(html).toContain("Listen on Apple Music");
    expect(html).toContain("matched by ISRC · confirmed May 1, 2026");
    expect(html).not.toContain("Not covered");
  });

  it("names the relation when one identifier answered with more than one recording", async () => {
    const html = await renderPage(
      found([
        recording({ relation: "ambiguous", trackId: "track-1" }),
        recording({ relation: "duplicate-of:track-1", title: "Mr Maverick (VIP)", trackId: "t2" }),
      ]),
    );

    expect(html).toContain("Fluncle has not ruled between these recordings.");
    expect(html.match(/has not ruled between these recordings/g)).toHaveLength(1);

    expect(html).toContain("Held as a duplicate of");
    expect(html).toContain('href="/identity/track-1"');
  });

  it("answers an unknown identifier honestly instead of erroring", async () => {
    const html = await renderPage({ key: "GBXXX0000000", kind: "isrc", status: "missing" });

    expect(html).toContain("Nothing on file under this identifier.");
    expect(html).toContain("GBXXX0000000");

    expect(html).not.toContain("Submit a track");

    expect(html).toContain('action="/identity"');
  });

  it("renders a spent allowance as a calm page, not a fault", async () => {
    const html = await renderPage({ status: "limited" });

    expect(html).toContain("That is a lot of lookups from one place in one go.");
    expect(html).toContain('href="/"');

    expect(html).not.toContain('action="/identity"');
  });
});

describe("the door's key routing", () => {
  it("routes each shape to its own read", () => {
    expect(identityKeyFor("gb-abc-12-34567")).toEqual({
      key: { isrcs: ["GBABC1234567"], kind: "isrc" },
      kind: "isrc",
    });
    expect(identityKeyFor("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")).toEqual({
      key: { kind: "mbid", mbid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
      kind: "mbid",
    });
    expect(
      identityKeyFor("https://open.spotify.com/intl-nl/track/4cOdK2wGLETKBW3PvgPWqT?si=x"),
    ).toEqual({
      key: { kind: "spotify", spotifyId: "4cOdK2wGLETKBW3PvgPWqT" },
      kind: "platform",
    });
    expect(identityKeyFor("https://www.deezer.com/nl/track/3135556")).toEqual({
      key: { deezerId: "3135556", kind: "deezer" },
      kind: "platform",
    });
  });

  it("leaves a bare string a reference key, coordinate or track id alike", () => {
    expect(identityKeyFor("004.7.2I")).toEqual({
      key: { idOrLogId: "004.7.2I", kind: "idOrLogId" },
      kind: "reference",
    });

    expect(identityKeyFor("4cOdK2wGLETKBW3PvgPWqT")).toEqual({
      key: { idOrLogId: "4cOdK2wGLETKBW3PvgPWqT", kind: "idOrLogId" },
      kind: "reference",
    });
  });
});
