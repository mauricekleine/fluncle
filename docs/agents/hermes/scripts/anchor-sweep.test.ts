// Unit tests for anchor-sweep.ts — the catalogue Spotify-anchor cron's orchestrator.
//
// The box only fetches candidates + POSTs them; the Worker verifies. So the contract worth
// pinning here is the box's MAPPING (Apify's flat result array → per-row candidates, grouped by
// the query `target`) and the tick's tally + fault handling. The fixtures below are trimmed to the
// exact fields the sweep consumes, in the shape the real actor returns (verified live 2026-07-18).
//
// Runs outside any package's test runner (bun:test), like crawl-sweep.test.ts:
//   bun test docs/agents/hermes/scripts/anchor-sweep.test.ts

import { describe, expect, test } from "bun:test";
import {
  type AnchorDeps,
  type ApifyResultItem,
  chunk,
  groupCandidatesByTarget,
  itemToCandidate,
  parseLimitArg,
  runAnchorTick,
  SPOTIFY_SEARCH_MIN_INTERVAL_MS,
  spotifySearchPaceMs,
} from "./anchor-sweep";

// A representative slice of the actor's output (artists + album on) — two candidates for one query.
const APIFY_SAMPLE: ApifyResultItem[] = [
  {
    albums: [{ album_image: "https://i.scdn.co/image/album1" }],
    artists: [{ artist_id: "29rsvX8tM1cbyZhn554CFk", artist_name: "Azuro" }],
    error: null,
    success: true,
    target: "Azuro Hold Tight",
    tracks: [
      {
        track_duration_ms: 319_112,
        track_id: "0RceyuivB4augSTMbNLKfw",
        track_image: "https://i.scdn.co/image/track1",
        track_isrc: "QZK6L2216560",
        track_name: "Hold Tight - Edit",
        track_uri: "spotify:track:0RceyuivB4augSTMbNLKfw",
        track_url: "https://open.spotify.com/track/0RceyuivB4augSTMbNLKfw",
      },
    ],
  },
  {
    albums: [{ album_image: "https://i.scdn.co/image/album2" }],
    artists: [{ artist_id: "03JgNMfOmGHddbWkzlZ7n4", artist_name: "DJ Steve Shinkle" }],
    error: null,
    success: true,
    target: "Azuro Hold Tight",
    tracks: [
      {
        track_duration_ms: 132_010,
        track_id: "1bQvXpSuvnJqAAMkmEIwhu",
        track_isrc: "QT3EY2633906",
        track_name: "Hold Tight",
        track_uri: "spotify:track:1bQvXpSuvnJqAAMkmEIwhu",
        track_url: "https://open.spotify.com/track/1bQvXpSuvnJqAAMkmEIwhu",
      },
    ],
  },
  {
    // Artists/album OFF (the pilot4 shape) — still maps, just with no artist ids.
    artists: [],
    error: null,
    success: true,
    target: "Technimatic For All of Us",
    tracks: [
      {
        track_duration_ms: 99_310,
        track_id: "1O5vkKnLHeGJY7zh7NUiuO",
        track_isrc: "GX2E32100015",
        track_name: "For All of Us",
      },
    ],
  },
];

describe("itemToCandidate", () => {
  test("maps a good item (id, isrc, duration, title, artists, cover)", () => {
    const candidate = itemToCandidate(APIFY_SAMPLE[0]);

    expect(candidate).toEqual({
      albumImageUrl: "https://i.scdn.co/image/track1",
      artists: [{ id: "29rsvX8tM1cbyZhn554CFk", name: "Azuro" }],
      durationMs: 319_112,
      isrc: "QZK6L2216560",
      spotifyTrackId: "0RceyuivB4augSTMbNLKfw",
      title: "Hold Tight - Edit",
    });
  });

  test("falls back to the album image when the track carries none", () => {
    expect(itemToCandidate(APIFY_SAMPLE[1])?.albumImageUrl).toBe("https://i.scdn.co/image/album2");
  });

  test("maps an artists-off item with an empty artist list", () => {
    const candidate = itemToCandidate(APIFY_SAMPLE[2]);

    expect(candidate?.artists).toEqual([]);
    expect(candidate?.spotifyTrackId).toBe("1O5vkKnLHeGJY7zh7NUiuO");
    expect(candidate?.albumImageUrl).toBeNull();
  });

  test("returns null for a failed item or one with no track id", () => {
    expect(itemToCandidate({ success: false, target: "x", tracks: [] })).toBeNull();
    expect(
      itemToCandidate({ success: true, target: "x", tracks: [{ track_name: "no id" }] }),
    ).toBeNull();
  });
});

describe("groupCandidatesByTarget", () => {
  test("groups items by the query target", () => {
    const byTarget = groupCandidatesByTarget(APIFY_SAMPLE);

    expect(byTarget.get("Azuro Hold Tight")?.map((c) => c.spotifyTrackId)).toEqual([
      "0RceyuivB4augSTMbNLKfw",
      "1bQvXpSuvnJqAAMkmEIwhu",
    ]);
    expect(byTarget.get("Technimatic For All of Us")?.length).toBe(1);
  });
});

describe("chunk / parseLimitArg", () => {
  test("chunk splits into fixed-size groups", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("parseLimitArg reads --limit N, else the fallback", () => {
    expect(parseLimitArg(["--limit", "40"], 15)).toBe(40);
    expect(parseLimitArg([], 15)).toBe(15);
    expect(parseLimitArg(["--limit", "-3"], 15)).toBe(15);
  });
});

describe("runAnchorTick", () => {
  function deps(overrides: Partial<AnchorDeps> = {}): AnchorDeps {
    return {
      fetchQueue: () =>
        Promise.resolve([
          { anchorQuery: "Azuro Hold Tight", trackId: "mb_hold" },
          { anchorQuery: "Technimatic For All of Us", trackId: "mb_fau" },
          { anchorQuery: "No Candidates Here", trackId: "mb_none" },
        ]),
      log: () => {},
      // A fixed clock + a no-op sleep by default: the pacer is exercised in its own tests below.
      now: () => 0,
      report: (trackId) =>
        Promise.resolve(
          trackId === "mb_hold"
            ? { anchored: true, verifiedBy: "isrc" }
            : trackId === "mb_fau"
              ? { anchored: true, verifiedBy: "search" }
              : { anchored: false, verifiedBy: null },
        ),
      // The free rung misses by default, so every row falls through to the Apify fallback — the
      // pre-waterfall behaviour the existing assertions were written against.
      resolveFree: () => Promise.resolve({ anchored: false, verifiedBy: null }),
      runActor: () => Promise.resolve(APIFY_SAMPLE),
      sleep: () => Promise.resolve(),
      ...overrides,
    };
  }

  test("tallies isrc / search anchors and a clean miss, and POSTs each row's grouped candidates", async () => {
    const posted: Record<string, number> = {};
    const summary = await runAnchorTick(
      50,
      deps({
        report: (trackId, candidates) => {
          posted[trackId] = candidates.length;

          return Promise.resolve(
            trackId === "mb_hold"
              ? { anchored: true, verifiedBy: "isrc" }
              : trackId === "mb_fau"
                ? { anchored: true, verifiedBy: "search" }
                : { anchored: false, verifiedBy: null },
          );
        },
      }),
    );

    expect(summary.ok).toBe(true);
    expect(summary.anchoredByIsrc).toBe(1);
    expect(summary.anchoredBySearch).toBe(1);
    expect(summary.missed).toBe(1);
    // The grouping routed the two Hold-Tight candidates to that row, one to FAU, none to mb_none.
    expect(posted).toEqual({ mb_fau: 1, mb_hold: 2, mb_none: 0 });
  });

  test("slice 2: the dark Spotify search rungs tally separately and never spend Apify", async () => {
    const reported: string[] = [];

    const summary = await runAnchorTick(
      50,
      deps({
        report: (trackId) => {
          reported.push(trackId);

          return Promise.resolve({ anchored: false, verifiedBy: null });
        },
        // The server resolved mb_hold via the Spotify ISRC rung and mb_fau via the fuzzy rung (each
        // a Spotify search); mb_none missed every free rung and falls to Apify.
        resolveFree: (trackId) =>
          Promise.resolve(
            trackId === "mb_hold"
              ? {
                  anchored: true,
                  source: "spotify-isrc",
                  spotifySearchDone: true,
                  verifiedBy: "isrc",
                }
              : trackId === "mb_fau"
                ? {
                    anchored: true,
                    source: "spotify-search",
                    spotifySearchDone: true,
                    verifiedBy: "search",
                  }
                : { anchored: false, source: null, spotifySearchDone: true, verifiedBy: null },
          ),
      }),
    );

    expect(summary.anchoredBySpotifyIsrc).toBe(1);
    expect(summary.anchoredBySpotifySearch).toBe(1);
    expect(summary.anchoredByListenbrainz).toBe(0);
    expect(summary.missed).toBe(1); // mb_none, via the Apify fallback
    // Only the full-miss row reached the paid anchor_track path.
    expect(reported).toEqual(["mb_none"]);
  });

  test("slice 2: the pacer spaces consecutive Spotify-search calls by ≥ the ceiling interval", async () => {
    const sleeps: number[] = [];
    let clock = 0;

    await runAnchorTick(
      50,
      deps({
        // Every free-rung call issues a Spotify search, so every call after the first must be paced.
        now: () => clock,
        resolveFree: () => {
          clock += 10; // each call advances the clock a little (far less than the interval)
          return Promise.resolve({
            anchored: false,
            source: null,
            spotifySearchDone: true,
            verifiedBy: null,
          });
        },
        sleep: (ms) => {
          sleeps.push(ms);
          clock += ms; // honouring the sleep advances the fake clock
          return Promise.resolve();
        },
      }),
    );

    // Three rows → the first runs free, the next two are paced by ~the full interval (minus the tiny
    // clock drift from the prior call). None is below the ceiling interval's near-full value.
    expect(sleeps.length).toBe(2);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThan(SPOTIFY_SEARCH_MIN_INTERVAL_MS - 100);
      expect(ms).toBeLessThanOrEqual(SPOTIFY_SEARCH_MIN_INTERVAL_MS);
    }
  });

  test("slice 2: a flag-OFF sweep (no Spotify search) is never paced — full speed", async () => {
    const sleeps: number[] = [];

    await runAnchorTick(
      50,
      deps({
        // The server never searched (flag off / Friday window): spotifySearchDone is false throughout.
        resolveFree: () =>
          Promise.resolve({
            anchored: false,
            source: null,
            spotifySearchDone: false,
            verifiedBy: null,
          }),
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      }),
    );

    expect(sleeps).toEqual([]);
  });

  test("a free-rung (ListenBrainz) hit anchors the row and NEVER spends Apify on it", async () => {
    const actorQueries: string[][] = [];
    const reported: string[] = [];

    const summary = await runAnchorTick(
      50,
      deps({
        // The free rung anchors mb_hold; the other two miss and fall through to Apify.
        report: (trackId) => {
          reported.push(trackId);

          return Promise.resolve(
            trackId === "mb_fau"
              ? { anchored: true, verifiedBy: "search" }
              : { anchored: false, verifiedBy: null },
          );
        },
        resolveFree: (trackId) =>
          Promise.resolve(
            trackId === "mb_hold"
              ? { anchored: true, verifiedBy: "isrc" }
              : { anchored: false, verifiedBy: null },
          ),
        runActor: (queries) => {
          actorQueries.push(queries);

          return Promise.resolve(APIFY_SAMPLE);
        },
      }),
    );

    expect(summary.anchoredByListenbrainz).toBe(1);
    expect(summary.anchoredBySearch).toBe(1); // mb_fau, via the Apify fallback
    expect(summary.missed).toBe(1); // mb_none
    // The Apify actor ran ONLY over the free-rung misses — mb_hold's query never reached it.
    expect(actorQueries.flat()).toEqual(["Technimatic For All of Us", "No Candidates Here"]);
    // And mb_hold was never POSTed to the paid anchor_track path.
    expect(reported).not.toContain("mb_hold");
  });

  test("a free rung that THROWS still lets the row spend Apify (never starves anchoring)", async () => {
    const summary = await runAnchorTick(
      50,
      deps({
        // The free rung errors on every row; each must still fall through to the Apify fallback.
        resolveFree: () => Promise.reject(new Error("resolve_anchor 500")),
      }),
    );

    expect(summary.ok).toBe(true);
    expect(summary.anchoredByListenbrainz).toBe(0);
    // The Apify fallback still ran on all three: mb_hold → isrc, mb_fau → search, mb_none → miss.
    expect(summary.anchoredByIsrc).toBe(1);
    expect(summary.anchoredBySearch).toBe(1);
    expect(summary.missed).toBe(1);
  });

  test("skips a worklist row missing a trackId or query", async () => {
    const summary = await runAnchorTick(
      50,
      deps({
        fetchQueue: () => Promise.resolve([{ trackId: "mb_no-query" }, { anchorQuery: "orphan" }]),
        runActor: () => Promise.resolve([]),
      }),
    );

    expect(summary.skipped).toBe(2);
    expect(summary.anchoredByIsrc + summary.anchoredBySearch + summary.missed).toBe(0);
  });

  test("an actor run that throws counts the chunk skipped, never aborts the tick", async () => {
    const summary = await runAnchorTick(
      50,
      deps({
        runActor: () => Promise.reject(new Error("apify 500")),
      }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.skipped).toBe(3);
    expect(summary.error).toContain("apify 500");
  });

  test("a failed worklist fetch reports ok:false, not a throw", async () => {
    const summary = await runAnchorTick(
      50,
      deps({ fetchQueue: () => Promise.reject(new Error("queue down")) }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("queue down");
  });
});

describe("spotifySearchPaceMs — the 60/min ceiling", () => {
  test("no wait before the first Spotify search (null last-start)", () => {
    expect(spotifySearchPaceMs(null, 10_000)).toBe(0);
  });

  test("waits out the remainder of the interval since the last search", () => {
    // 500ms elapsed since the last search's start → wait the remaining 1500ms.
    expect(spotifySearchPaceMs(0, 500)).toBe(SPOTIFY_SEARCH_MIN_INTERVAL_MS - 500);
  });

  test("no wait once the interval has fully elapsed", () => {
    expect(spotifySearchPaceMs(0, SPOTIFY_SEARCH_MIN_INTERVAL_MS)).toBe(0);
    expect(spotifySearchPaceMs(0, SPOTIFY_SEARCH_MIN_INTERVAL_MS + 5_000)).toBe(0);
  });

  test("the ceiling holds: ≤ 2 searches per interval ⇒ ≤ 60/min", () => {
    // resolve_anchor issues at most 2 searches per row, and consecutive search-bearing calls are
    // held ≥ 2s apart, so the sustained rate is ≤ 2 / 2s = 60/min.
    const searchesPerCall = 2;
    const callsPerMinute = 60_000 / SPOTIFY_SEARCH_MIN_INTERVAL_MS;
    expect(callsPerMinute * searchesPerCall).toBeLessThanOrEqual(60);
  });
});
