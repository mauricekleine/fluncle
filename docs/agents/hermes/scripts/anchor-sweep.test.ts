// Unit tests for anchor-sweep.ts — the catalogue Spotify-anchor cron's orchestrator.
//
// The box only fetches candidates + POSTs them; the Worker verifies. So the contract worth
// pinning here is the box's MAPPING (Apify's flat result array → per-row candidates, grouped by
// the query `target`) and the tick's tally + fault handling. The fixtures below are trimmed to the
// exact fields the sweep consumes, in the shape the real actor returns (verified live 2026-07-18).
//
// Runs outside any package's test runner (bun:test), like crawl-sweep.test.ts:
//   bun test docs/agents/hermes/scripts/anchor-sweep.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import {
  type AnchorDeps,
  type ApifyResultItem,
  chunk,
  groupCandidatesByTarget,
  itemToCandidate,
  parseLimitArg,
  runApifyActor,
  runAnchorSweep,
  runAnchorTick,
  searchDeezerOnBox,
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
      // No default worklist row carries a `deezerQuery`, so this is never reached unless a test
      // opts in — the Deezer rung is scoped to ISRC-less rows by the SERVER, not by the sweep.
      searchDeezer: () => Promise.resolve([]),
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
    expect(summary).toMatchObject({ checked: 3, errors: 0, produced: 2, queueDepth: 0 });
    // The grouping routed the two Hold-Tight candidates to that row, one to FAU, none to mb_none.
    expect(posted).toEqual({ mb_fau: 1, mb_hold: 2, mb_none: 0 });
  });

  test("queueDepth is the real whole backlog left behind, not the page size", async () => {
    const summary = await runAnchorTick(
      3,
      deps({
        fetchQueue: () =>
          Promise.resolve({
            queueDepth: 10,
            rows: [
              { anchorQuery: "Azuro Hold Tight", trackId: "mb_hold" },
              { anchorQuery: "Technimatic For All of Us", trackId: "mb_fau" },
              { anchorQuery: "No Candidates Here", trackId: "mb_none" },
            ],
          }),
      }),
    );

    expect(summary).toMatchObject({ checked: 3, produced: 2, queueDepth: 7 });
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

  test("tallies Deezer ISRC recoveries regardless of whether the row then anchored", async () => {
    const summary = await runAnchorTick(
      50,
      deps({
        // mb_hold recovered its ISRC AND anchored (ListenBrainz); mb_fau recovered but still missed
        // every free rung (it falls to Apify); mb_none recovered nothing. The recovery count is
        // orthogonal to anchoring, so it must be 2.
        resolveFree: (trackId) =>
          Promise.resolve(
            trackId === "mb_hold"
              ? {
                  anchored: true,
                  isrcRecoveredByDeezer: true,
                  source: "listenbrainz",
                  verifiedBy: "isrc",
                }
              : trackId === "mb_fau"
                ? { anchored: false, isrcRecoveredByDeezer: true, verifiedBy: null }
                : { anchored: false, isrcRecoveredByDeezer: false, verifiedBy: null },
          ),
      }),
    );

    expect(summary.isrcRecoveredByDeezer).toBe(2);
    expect(summary.anchoredByListenbrainz).toBe(1);
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

  test("ListenBrainz outcomes stay distinguishable in one tick's summary", async () => {
    const outcomeCounts = [
      ["no-mbid", 1],
      ["no-map", 2],
      ["empty-ids", 3],
      ["request-failed", 4],
      ["metadata-failed", 5],
      ["gate-rejected", 6],
      ["not-attempted", 7],
    ] as const;
    const work = outcomeCounts.flatMap(([outcome, count]) =>
      Array.from({ length: count }, (_, index) => ({
        anchorQuery: `${outcome}-${index}`,
        trackId: `mb_${outcome}-${index}`,
      })),
    );
    const summary = await runAnchorTick(
      work.length,
      deps({
        fetchQueue: () => Promise.resolve(work),
        report: () => Promise.resolve({ anchored: false, verifiedBy: null }),
        resolveFree: (trackId) =>
          Promise.resolve({
            anchored: false,
            listenbrainzOutcome: trackId
              .slice("mb_".length)
              .replace(/-\d+$/, "") as (typeof outcomeCounts)[number][0],
            verifiedBy: null,
          }),
        runActor: () => Promise.resolve([]),
      }),
    );

    expect(summary).toMatchObject({
      checked: 28,
      errors: 0,
      failed: 9,
      lbEmptyIds: 3,
      lbGateRejected: 6,
      lbMetadataFailed: 5,
      lbNoMap: 2,
      lbNoMbid: 1,
      lbNotAttempted: 7,
      lbRequestFailed: 4,
      produced: 0,
      queueDepth: 0,
    });
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
    // …and the throw is REPORTED. With Apify enabled these rows anchor via the fallback, so the tick
    // reads healthy — which is exactly how a dead free rung stayed invisible for a week. The count is
    // unconditional so the very first tick after a breakage says so.
    expect(summary.freeRungErrors).toBe(3);
    expect(summary.error).toBeNull();
    expect(summary.errors).toBe(0);
    expect(summary.failed).toBe(3);
  });

  test("freeRungErrors is zero on a clean tick and survives the paged merge", async () => {
    expect((await runAnchorTick(50, deps())).freeRungErrors).toBe(0);

    // Two pages, one throwing row each → the merged summary must carry both, not the last page's.
    const paged = await runAnchorSweep(
      6,
      deps({
        fetchQueue: () =>
          Promise.resolve([
            { anchorQuery: "q1", trackId: "mb_a" },
            { anchorQuery: "q2", trackId: "mb_b" },
            { anchorQuery: "q3", trackId: "mb_c" },
          ]),
        resolveFree: (trackId) =>
          trackId === "mb_c"
            ? Promise.reject(new Error("resolve_anchor 500"))
            : Promise.resolve({ anchored: true, source: "listenbrainz", verifiedBy: "isrc" }),
      }),
      3,
    );

    expect(paged.pages).toBe(2);
    expect(paged.freeRungErrors).toBe(2);
  });

  test("Deezer rung 0: the box searches ONLY the rows the worklist asked it to, and hands the hits over", async () => {
    const searched: string[] = [];
    const supplied: Record<string, unknown> = {};
    const hits = [
      { artistName: "Muffler", durationMs: 201_000, isrc: "GBBOXDZ00001", title: "Dribble" },
    ];

    const summary = await runAnchorTick(
      50,
      deps({
        fetchQueue: () =>
          Promise.resolve([
            // ISRC-LESS ⇒ the server attached a `deezerQuery`, so this row gets the search.
            {
              anchorQuery: "Muffler Dribble",
              deezerQuery: 'artist:"Muffler" track:"Dribble"',
              trackId: "mb_dz",
            },
            // Already has an ISRC ⇒ no `deezerQuery`, so no Deezer request is spent on it.
            { anchorQuery: "Azuro Hold Tight", trackId: "mb_hold" },
          ]),
        resolveFree: (trackId, deezerCandidates) => {
          supplied[trackId] = deezerCandidates;

          return Promise.resolve({
            anchored: true,
            isrcRecoveredByDeezer: trackId === "mb_dz",
            source: "listenbrainz",
            verifiedBy: "isrc",
          });
        },
        searchDeezer: (query) => {
          searched.push(query);

          return Promise.resolve(hits);
        },
      }),
    );

    expect(searched).toEqual(['artist:"Muffler" track:"Dribble"']);
    // The hits ride the resolve call VERBATIM — the box normalizes, the Worker verifies and writes.
    expect(supplied.mb_dz).toEqual(hits);
    // A row with no `deezerQuery` sends NOTHING, so the server keeps its own (unchanged) behaviour.
    expect(supplied.mb_hold).toBeUndefined();
    expect(summary.isrcRecoveredByDeezer).toBe(1);
    expect(summary.deezerSearchFailed).toBe(0);
  });

  test("Deezer rung 0: a FAILED box-side search is tallied and sends an empty list, never a re-ask", async () => {
    const supplied: Record<string, unknown> = {};

    const summary = await runAnchorTick(
      50,
      deps({
        fetchQueue: () =>
          Promise.resolve([
            { anchorQuery: "q1", deezerQuery: 'artist:"A" track:"B"', trackId: "mb_fail" },
            { anchorQuery: "q2", deezerQuery: 'artist:"C" track:"D"', trackId: "mb_empty" },
          ]),
        resolveFree: (trackId, deezerCandidates) => {
          supplied[trackId] = deezerCandidates;

          return Promise.resolve({ anchored: false, verifiedBy: null });
        },
        // `null` = the search FAILED (quota-blind, network, bad body); `[]` = an honest empty result.
        searchDeezer: (query) => Promise.resolve(query.includes('"A"') ? null : []),
      }),
    );

    // Only the failure counts — the honest miss is not a fault, and conflating them would hide the
    // one signal that says this box has gone quota-blind now that the fetch lives here.
    expect(summary.deezerSearchFailed).toBe(1);
    // BOTH send an empty list: re-asking from the saturated shared edge is a known-dead request.
    expect(supplied.mb_fail).toEqual([]);
    expect(supplied.mb_empty).toEqual([]);
  });

  test("Deezer rung 0: a search that THROWS is a failure, never a tick abort", async () => {
    const summary = await runAnchorTick(
      50,
      deps({
        fetchQueue: () =>
          Promise.resolve([
            { anchorQuery: "q1", deezerQuery: 'artist:"A" track:"B"', trackId: "mb_throw" },
          ]),
        searchDeezer: () => Promise.reject(new Error("deezer exploded")),
      }),
    );

    expect(summary.ok).toBe(true);
    expect(summary.deezerSearchFailed).toBe(1);
    // The row still ran the whole waterfall — it just recovered no ISRC.
    expect(summary.missed).toBe(1);
  });

  test("slice 3: Apify OFF ⇒ SKIP the actor loop entirely; full misses counted `missed`, not skipped", async () => {
    let actorCalls = 0;

    const summary = await runAnchorTick(
      50,
      deps({
        // Out of Apify budget. Every free-rung call reports the global kill-flag OFF and misses — the
        // server has already stamped-and-backed-off each row (slice 3), so they are terminal.
        resolveFree: () =>
          Promise.resolve({ anchored: false, apifyEnabled: false, verifiedBy: null }),
        runActor: (queries) => {
          actorCalls += 1;

          return Promise.resolve(
            APIFY_SAMPLE.filter((item) => queries.includes(item.target ?? "")),
          );
        },
      }),
    );

    expect(summary.ok).toBe(true);
    // ZERO wasted 403-ing actor calls while out of budget.
    expect(actorCalls).toBe(0);
    // All three full misses are counted honestly as missed (terminal, backed off), never skipped-for-retry.
    expect(summary.missed).toBe(3);
    expect(summary.skipped).toBe(0);
    expect(summary.anchoredByIsrc + summary.anchoredBySearch).toBe(0);
  });

  test("slice 3: Apify OFF ⇒ a free-rung THROW is counted `skipped` (no stamp), the misses `missed`", async () => {
    let actorCalls = 0;

    const summary = await runAnchorTick(
      50,
      deps({
        // mb_hold/mb_fau report the flag OFF and miss (stamped by the server); mb_none THREW (no verdict,
        // so the server stamped nothing) — it is honestly skipped-for-retry, not a terminal miss.
        resolveFree: (trackId) =>
          trackId === "mb_none"
            ? Promise.reject(new Error("resolve_anchor 500"))
            : Promise.resolve({ anchored: false, apifyEnabled: false, verifiedBy: null }),
        runActor: () => {
          actorCalls += 1;

          return Promise.resolve(APIFY_SAMPLE);
        },
      }),
    );

    expect(summary.ok).toBe(true);
    expect(actorCalls).toBe(0);
    // The two stamped full misses → missed; the un-stamped throw → skipped.
    expect(summary.missed).toBe(2);
    expect(summary.skipped).toBe(1);
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
    expect(summary.errors).toBe(0);
    expect(summary.failed).toBe(2);
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
    expect(summary.apifyActorErrors).toBe(1);
    expect(summary.errors).toBe(1);
    expect(summary.error).toContain("apify 500");
  });

  test("N failed Apify chunks report N failures, never only the last one", async () => {
    const work = Array.from({ length: 5 }, (_, index) => ({
      anchorQuery: `query ${index}`,
      trackId: `mb_${index}`,
    }));
    let actorCalls = 0;
    const summary = await runAnchorTick(
      5,
      deps({
        fetchQueue: () => Promise.resolve(work),
        runActor: () => {
          actorCalls += 1;

          return Promise.reject(new Error(`apify failed chunk ${actorCalls}`));
        },
      }),
      2,
    );

    expect(actorCalls).toBe(3);
    expect(summary.apifyActorErrors).toBe(3);
    expect(summary.errors).toBe(3);
    expect(summary.skipped).toBe(5);
    // The diagnostic is stable instead of last-write-wins; the numeric counters carry all N failures.
    expect(summary.error).toBe("apify failed chunk 1");
  });

  test("a 200 with Deezer's real non-array error shape is an Apify ERROR, never an empty result", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({
          error: { code: 4, message: "Quota limit exceeded", type: "Exception" },
        }),
      )) as typeof globalThis.fetch;

    try {
      const summary = await runAnchorTick(
        1,
        deps({
          fetchQueue: () =>
            Promise.resolve([{ anchorQuery: "Calibre Mr Right On", trackId: "mb_non_array" }]),
          runActor: runApifyActor,
        }),
      );

      expect(summary.apifyActorErrors).toBe(1);
      expect(summary.errors).toBe(1);
      expect(summary.missed).toBe(0);
      expect(summary.skipped).toBe(1);
      expect(summary.error).toContain("expected an array");
      expect(summary.error).toContain("Quota limit exceeded");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a failed worklist fetch reports ok:false, not a throw", async () => {
    const summary = await runAnchorTick(
      50,
      deps({ fetchQueue: () => Promise.reject(new Error("queue down")) }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.errors).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.error).toContain("queue down");
  });
});

test("a genuine anchor run failure reports errors:1 and exits non-zero", async () => {
  const env = { ...process.env };
  delete env.FLUNCLE_API_TOKEN;
  delete env.APIFY_API_TOKEN;

  const proc = Bun.spawn(
    [process.execPath, new URL("./anchor-sweep.ts", import.meta.url).pathname],
    {
      env,
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  expect(exitCode).not.toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ errors: 1, ok: false });
});

// ── THE BOX-SIDE DEEZER CLIENT (rung 0's fetch) ──────────────────────────────────────────────────
// This code exists on the box precisely because Deezer's tokenless quota is per-IP: from Cloudflare's
// shared edge the rung recovered 0 ISRCs out of 5,133 rows over 3 days, against 25/25 clean here. It
// NORMALIZES and never judges — the Worker still verifies every hit and writes the ISRC. The one thing
// it must get right is telling a FAILURE apart from an honest empty result, because Deezer signals a
// throttle with HTTP **200** + an error body, and reading that as a miss is what hid the outage.
describe("searchDeezerOnBox", () => {
  const HIT = {
    artist: { name: "Calibre" },
    duration: 132,
    isrc: "GBEXH1900314",
    title: "Mr Right On",
  };
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("maps hits to the four fields the Worker's gate reads (duration promoted to ms)", async () => {
    const calls: string[] = [];
    globalThis.fetch = ((url: string) => {
      calls.push(String(url));

      return Promise.resolve(Response.json({ data: [HIT] }));
    }) as typeof globalThis.fetch;

    expect(await searchDeezerOnBox('artist:"Calibre" track:"Mr Right On"')).toEqual([
      { artistName: "Calibre", durationMs: 132_000, isrc: "GBEXH1900314", title: "Mr Right On" },
    ]);
    // The server's spelling is sent VERBATIM — the sweep never rewrites the query it was handed.
    expect(decodeURIComponent(calls[0])).toContain('artist:"Calibre" track:"Mr Right On"');
    expect(calls[0]).toContain("https://api.deezer.com/search/track?q=");
  });

  test("drops a hit missing any signal the gate needs, rather than sending an unverifiable one", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({
          data: [
            HIT,
            { ...HIT, isrc: "  " }, // no ISRC → there is nothing to recover
            { ...HIT, duration: 0 }, // no duration → the window cannot be applied
            { ...HIT, artist: { name: "" } }, // no artist → the fold cannot be applied
            { ...HIT, title: undefined }, // no title → the fold cannot be applied
          ],
        }),
      )) as typeof globalThis.fetch;

    expect((await searchDeezerOnBox("q"))?.map((hit) => hit.isrc)).toEqual(["GBEXH1900314"]);
  });

  test("an empty result set is [] (an honest miss), NOT a failure", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(Response.json({ data: [] }))) as typeof globalThis.fetch;

    expect(await searchDeezerOnBox("q")).toEqual([]);
  });

  test("THE QUOTA TRAP: a 200 carrying an error body is retried, then reported as a FAILURE", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;

      return Promise.resolve(
        Response.json({ error: { code: 4, message: "Quota limit exceeded", type: "Exception" } }),
      );
    }) as typeof globalThis.fetch;

    // `null`, never `[]` — reading a throttle as a clean miss is exactly what made the edge failure
    // invisible for a week, and on the box it would hide a quota-blind IP the same way.
    expect(await searchDeezerOnBox("q", [0, 0])).toBeNull();
    expect(calls).toBe(3); // the first attempt plus the two bounded retries
  });

  test("a quota answer that clears on retry returns the candidates", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;

      return Promise.resolve(
        calls === 1 ? Response.json({ error: { code: 4 } }) : Response.json({ data: [HIT] }),
      );
    }) as typeof globalThis.fetch;

    expect((await searchDeezerOnBox("q", [0, 0]))?.length).toBe(1);
    expect(calls).toBe(2);
  });

  test("a non-quota error body, a non-2xx, a bad body, and a thrown fetch are all failures — never a throw", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(Response.json({ error: { code: 700 } }))) as typeof globalThis.fetch;
    expect(await searchDeezerOnBox("q", [0, 0])).toBeNull();

    globalThis.fetch = (() =>
      Promise.resolve(new Response("nope", { status: 503 }))) as typeof globalThis.fetch;
    expect(await searchDeezerOnBox("q", [0, 0])).toBeNull();

    globalThis.fetch = (() =>
      Promise.resolve(new Response("<html>", { status: 200 }))) as typeof globalThis.fetch;
    expect(await searchDeezerOnBox("q", [0, 0])).toBeNull();

    globalThis.fetch = (() => Promise.resolve(Response.json({}))) as typeof globalThis.fetch;
    expect(await searchDeezerOnBox("q", [0, 0])).toBeNull();

    globalThis.fetch = (() => Promise.reject(new Error("socket"))) as typeof globalThis.fetch;
    expect(await searchDeezerOnBox("q", [0, 0])).toBeNull();
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

describe("runAnchorSweep (paging past the worklist cap)", () => {
  function pagedDeps(pages: { anchorQuery: string; trackId: string }[][]): AnchorDeps {
    let call = 0;

    return {
      fetchQueue: (limit) => {
        const page = pages[Math.min(call, pages.length - 1)].slice(0, limit);
        call += 1;

        return Promise.resolve(page);
      },
      log: () => {},
      now: () => 0,
      report: () => Promise.resolve({ anchored: false, verifiedBy: null }),
      resolveFree: () => Promise.resolve({ anchored: true, verifiedBy: "isrc" }),
      runActor: () => Promise.resolve([]),
      searchDeezer: () => Promise.resolve([]),
      sleep: () => Promise.resolve(),
    };
  }

  function rows(prefix: string, n: number): { anchorQuery: string; trackId: string }[] {
    return Array.from({ length: n }, (_, i) => ({
      anchorQuery: `${prefix} q${i}`,
      trackId: `${prefix}_${i}`,
    }));
  }

  test("spends the batch across pages: 5 asked at page size 2 pulls 2+2+1", async () => {
    const summary = await runAnchorSweep(
      5,
      pagedDeps([rows("a", 2), rows("b", 2), rows("c", 2), rows("d", 2)]),
      2,
    );

    expect(summary.pages).toBe(3);
    expect(summary.pulled).toBe(5);
    expect(summary.anchoredByListenbrainz).toBe(5);
    expect(summary.ok).toBe(true);
  });

  test("a short page means the queue ran dry — no further fetches", async () => {
    const summary = await runAnchorSweep(10, pagedDeps([rows("a", 2), [], []]), 2);

    expect(summary.pages).toBe(2);
    expect(summary.pulled).toBe(2);
  });

  test("carries the Deezer recovery + failure tallies across pages", async () => {
    // Regression: the paged merge summed every anchor tally but silently DROPPED
    // `isrcRecoveredByDeezer`, so a `--limit` burn always reported 0 recoveries — the one number
    // that says whether the ISRC-recovery rung is alive at all.
    const base = pagedDeps([rows("a", 2), rows("b", 2), rows("c", 2)]);
    const summary = await runAnchorSweep(
      4,
      {
        ...base,
        resolveFree: () =>
          Promise.resolve({
            anchored: true,
            isrcRecoveredByDeezer: true,
            source: "listenbrainz",
            verifiedBy: "isrc",
          }),
        searchDeezer: () => Promise.resolve(null),
      },
      2,
    );

    expect(summary.pages).toBe(2);
    expect(summary.isrcRecoveredByDeezer).toBe(4);
    // No page's row carried a `deezerQuery`, so no search ran and nothing failed.
    expect(summary.deezerSearchFailed).toBe(0);
  });

  test("carries the ListenBrainz failure counters across pages", async () => {
    const base = pagedDeps([rows("a", 2), rows("b", 2)]);
    const summary = await runAnchorSweep(
      4,
      {
        ...base,
        resolveFree: (trackId) =>
          Promise.resolve({
            anchored: false,
            listenbrainzOutcome: trackId.endsWith("_0") ? "no-map" : "metadata-failed",
            verifiedBy: null,
          }),
      },
      2,
    );

    expect(summary.pages).toBe(2);
    expect(summary.lbNoMap).toBe(2);
    expect(summary.lbMetadataFailed).toBe(2);
    expect(summary.errors).toBe(0);
    expect(summary.failed).toBe(2);
  });

  test("a failing page stops the sweep and carries the error", async () => {
    const deps = pagedDeps([rows("a", 2)]);
    let call = 0;
    const flaky: AnchorDeps = {
      ...deps,
      fetchQueue: (limit) => {
        call += 1;

        return call === 1 ? deps.fetchQueue(limit) : Promise.reject(new Error("worker down"));
      },
    };
    const summary = await runAnchorSweep(10, flaky, 2);

    expect(summary.ok).toBe(false);
    expect(summary.error).toBe("worker down");
    expect(summary.pages).toBe(2);
    expect(summary.pulled).toBe(2);
  });
});
