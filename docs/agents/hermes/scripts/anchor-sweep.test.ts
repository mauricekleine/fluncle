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
  anchorFiringDeferral,
  type AnchorPreflight,
  type ApifyResultItem,
  chunk,
  groupCandidatesByTarget,
  itemToCandidate,
  newSpotifyAskState,
  parseIsrcAskWindow,
  parseLimitArg,
  runApifyActor,
  runAnchorSweep,
  runAnchorTick,
  searchDeezerOnBox,
  SPOTIFY_SEARCH_MIN_INTERVAL_MS,
  spotifyAskDeferral,
  spotifySearchPaceMs,
  withinIsrcAskWindow,
} from "./anchor-sweep";

/** The sweep's own default Apify chunk size — passed positionally so the ask state can follow it. */
const ACTOR_CHUNK = 15;

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

  test("a free rung that THROWS never spends Apify — the server alone admits a row", async () => {
    let actorRuns = 0;
    const summary = await runAnchorTick(
      50,
      deps({
        // The free rung errors on every row. The server is the only thing that may admit a row to
        // the paid fallback, so a row it never answered about must not be bought on a guess.
        resolveFree: () => Promise.reject(new Error("resolve_anchor 500")),
        runActor: () => {
          actorRuns += 1;

          return Promise.resolve([]);
        },
      }),
    );

    expect(summary.ok).toBe(true);
    expect(actorRuns).toBe(0);
    expect(summary.apifyRowsSent).toBe(0);
    expect(summary.anchoredByIsrc).toBe(0);
    expect(summary.anchoredBySearch).toBe(0);
    // Nothing was asked, so nothing was settled: the rows are skipped and the next tick asks again.
    expect(summary.missed).toBe(0);
    expect(summary.skipped).toBe(3);
    // …and the throw is REPORTED, unconditionally, so the very first tick after a breakage says so.
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

  // ── AN HONEST TICK: `missed` means RETIRED, and a tick that could conclude on nothing says so ────
  //
  // `missed` is the tick's claim that a row left the backlog. When the server parks nothing — every
  // row deferred, or no rung armed to conclude — the queue depth does not move, and a summary that
  // counts those rows as misses reports a drain that is standing still. Both sides are pinned: the
  // parked case must still count `missed`, the unparked case must count `deferred`.

  test("a verdict that PARKED the row counts `missed`; one that did not counts `deferred`", async () => {
    const summary = await runAnchorTick(
      50,
      deps({
        fetchQueue: () =>
          Promise.resolve({
            queueDepth: 40,
            rows: [
              { anchorQuery: "Azuro Hold Tight", trackId: "mb_hold" },
              { anchorQuery: "Technimatic For All of Us", trackId: "mb_fau" },
            ],
          }),
        resolveFree: (trackId) =>
          Promise.resolve({
            anchored: false,
            apifyEnabled: false,
            spotifySearchEnabled: false,
            stamped: trackId === "mb_hold",
            verifiedBy: null,
          }),
      }),
    );

    expect(summary.missed).toBe(1);
    expect(summary.deferred).toBe(1);
    // ONLY the parked row left the backlog — the deferred one is still in it.
    expect(summary.queueDepth).toBe(39);
  });

  test("a tick with no rung capable of concluding reports `no_capable_rung`", async () => {
    const summary = await runAnchorTick(
      50,
      deps({
        resolveFree: () =>
          Promise.resolve({
            anchored: false,
            apifyEnabled: false,
            spotifySearchEnabled: false,
            stamped: true,
            verifiedBy: null,
          }),
      }),
    );

    expect(summary.ok).toBe(true);
    expect(summary.produced).toBe(0);
    expect(summary.reason).toBe("no_capable_rung");
  });

  test("a rung that CAN conclude, or a win, leaves `reason` null — the tripwire is not always-on", async () => {
    // Side one: the paid rung is armed, so the tick could have concluded on every row.
    const armed = await runAnchorTick(
      50,
      deps({
        resolveFree: () =>
          Promise.resolve({
            anchored: false,
            apifyEnabled: true,
            spotifySearchEnabled: false,
            verifiedBy: null,
          }),
      }),
    );

    expect(armed.reason).toBeNull();

    // Side two: nothing is armed, but the free ListenBrainz oracle WON — the tick concluded.
    const won = await runAnchorTick(
      50,
      deps({
        resolveFree: () =>
          Promise.resolve({
            anchored: true,
            apifyEnabled: false,
            source: "listenbrainz",
            spotifySearchEnabled: false,
            stamped: false,
            verifiedBy: "isrc",
          }),
      }),
    );

    expect(won.produced).toBe(3);
    expect(won.reason).toBeNull();
  });

  test("a server that never reports the flags claims no capability verdict", async () => {
    // The pinned box can outlive a Worker that predates `spotifySearchEnabled`. Silence is not
    // evidence: the tick must not invent `no_capable_rung` from a field it never received.
    const summary = await runAnchorTick(
      50,
      deps({
        resolveFree: () =>
          Promise.resolve({ anchored: false, apifyEnabled: false, verifiedBy: null }),
      }),
    );

    expect(summary.reason).toBeNull();
    // And the older server's misses still settle exactly as they did before `stamped` existed.
    expect(summary.missed).toBe(3);
    expect(summary.deferred).toBe(0);
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

  // ── THE LISTENBRAINZ RUNG'S BREAKER YIELD ──────────────────────────────────────────────────────
  // Through Spotify's throttle windows every LB candidate died on the rung's one by-id read, and the
  // tick reported it as `lbMetadataFailed` — a broken rung, when the rung was fine and Spotify was
  // pushing back. The server now says which it is; the tick must keep them apart.
  test("a yielded ListenBrainz rung counts as a YIELD, never as a metadata failure", async () => {
    const summary = await runAnchorTick(
      50,
      deps({
        resolveFree: (trackId) =>
          Promise.resolve(
            trackId === "mb_none"
              ? { anchored: false, listenbrainzOutcome: "metadata-failed", verifiedBy: null }
              : { anchored: false, listenbrainzOutcome: "yielded-on-breaker", verifiedBy: null },
          ),
      }),
    );

    expect(summary.lbYieldedOnBreaker).toBe(2);
    expect(summary.lbMetadataFailed).toBe(1);
    // A yield is not a failure: only the genuine metadata failure moves `failed`.
    expect(summary.failed).toBe(1);
  });

  // ── THE THREE TICK GUARDS (the Spotify rungs as a subordinate consumer) ─────────────────────────
  test("the exact-ISRC ask budget defers the Spotify leg once it is spent", async () => {
    const asked: (boolean | undefined)[] = [];
    const summary = await runAnchorTick(
      50,
      deps({
        resolveFree: (_trackId, _deezer, options) => {
          asked.push(options?.spotifySearch);

          return Promise.resolve({
            anchored: false,
            // Every allowed call spends an exact-ISRC ask; a deferred one cannot.
            spotifyIsrcAsked: options?.spotifySearch !== false,
            verifiedBy: null,
          });
        },
      }),
      ACTOR_CHUNK,
      newSpotifyAskState(2, ""),
    );

    // Two asks spend the budget; the third row is deferred — and the deferral is the ONLY thing the
    // box sends, so the first two requests are byte-identical to a pre-slice one.
    expect(asked).toEqual([undefined, undefined, false]);
    expect(summary.spotifyIsrcAsks).toBe(2);
    expect(summary.spotifyDeferredBudget).toBe(1);
  });

  test("the night window defers every row when the clock is outside it", async () => {
    const asked: (boolean | undefined)[] = [];
    const summary = await runAnchorTick(
      50,
      deps({
        // 12:00 UTC — outside "0-8".
        now: () => Date.UTC(2026, 7, 2, 12, 0, 0),
        resolveFree: (_trackId, _deezer, options) => {
          asked.push(options?.spotifySearch);

          return Promise.resolve({ anchored: false, verifiedBy: null });
        },
      }),
      ACTOR_CHUNK,
      newSpotifyAskState(25, "0-8"),
    );

    expect(asked).toEqual([false, false, false]);
    expect(summary.spotifyDeferredWindow).toBe(3);
    expect(summary.spotifyIsrcAsks).toBe(0);
  });

  test("inside the night window nothing is deferred", async () => {
    const asked: (boolean | undefined)[] = [];

    await runAnchorTick(
      50,
      deps({
        // 03:00 UTC — inside "0-8".
        now: () => Date.UTC(2026, 7, 2, 3, 0, 0),
        resolveFree: (_trackId, _deezer, options) => {
          asked.push(options?.spotifySearch);

          return Promise.resolve({ anchored: false, verifiedBy: null });
        },
      }),
      ACTOR_CHUNK,
      newSpotifyAskState(25, "0-8"),
    );

    expect(asked).toEqual([undefined, undefined, undefined]);
  });

  test("THE YIELD LAW: one 429 ends every remaining Spotify ask in the tick", async () => {
    const asked: (boolean | undefined)[] = [];
    const summary = await runAnchorTick(
      50,
      deps({
        resolveFree: (trackId, _deezer, options) => {
          asked.push(options?.spotifySearch);

          return Promise.resolve({
            anchored: false,
            spotifyIsrcAsked: options?.spotifySearch !== false,
            // The FIRST row eats the throttle; every row after it must be deferred.
            spotifyThrottled: trackId === "mb_hold",
            verifiedBy: null,
          });
        },
      }),
      ACTOR_CHUNK,
      newSpotifyAskState(25, ""),
    );

    expect(asked).toEqual([undefined, false, false]);
    expect(summary.spotifyDeferredYield).toBe(2);
    // The throttled row is NOT a failure and NOT a skip — it falls to Apify like any other miss.
    expect(summary.failed).toBe(0);
    expect(summary.spotifyIsrcAsks).toBe(1);
  });

  test("the ask budget and the yield law span PAGES, not pages each", async () => {
    let served = 0;
    const asked: (boolean | undefined)[] = [];

    // Two pages of one row each. A per-page ask state would hand the second page a fresh budget.
    await runAnchorSweep(
      2,
      deps({
        fetchQueue: () => {
          served += 1;

          return Promise.resolve([{ anchorQuery: `q${served}`, trackId: `mb_${served}` }]);
        },
        resolveFree: (_trackId, _deezer, options) => {
          asked.push(options?.spotifySearch);

          return Promise.resolve({
            anchored: false,
            spotifyIsrcAsked: options?.spotifySearch !== false,
            verifiedBy: null,
          });
        },
      }),
      1,
    );

    // The env default is 25, so both rows are allowed here — what this pins is that the SECOND page
    // ran under the same state object at all (a fresh one would also allow it, so the assertion that
    // matters is the budget test above; this one guards the plumbing).
    expect(asked.length).toBe(2);
  });

  // ── THE OBSERVABILITY COUNTERS ─────────────────────────────────────────────────────────────────
  test("surfaces the Worker's free-rung durationless-candidate count", async () => {
    const summary = await runAnchorTick(
      50,
      deps({
        fetchQueue: () =>
          Promise.resolve([{ anchorQuery: "Muffler Dribble", trackId: "mb_durationless" }]),
        resolveFree: () =>
          Promise.resolve({
            anchored: true,
            freeDurationMsOmitted: 2,
            source: "listenbrainz",
            verifiedBy: "isrc",
          }),
      }),
    );

    expect(summary.freeDurationMsOmitted).toBe(2);
    expect(summary.produced).toBe(1);
    expect(summary.missed).toBe(0);
  });

  test("counts the rows whose query the Apify dataset came back WITHOUT", async () => {
    const summary = await runAnchorTick(
      50,
      deps({
        report: () => Promise.resolve({ anchored: false, verifiedBy: null }),
        // The actor answered for two of the three queries; "No Candidates Here" is simply absent.
        runActor: () => Promise.resolve(APIFY_SAMPLE),
      }),
    );

    expect(summary.apifyTargetOmitted).toBe(1);
    // STAMPING IS UNCHANGED — the row is still a clean miss. This slice measures the class, it does
    // not act on it.
    expect(summary.missed).toBe(3);
  });

  test("counts Apify candidates that arrive without a numeric durationMs", async () => {
    const posted: { candidates: { durationMs?: null | number }[]; trackId: string }[] = [];
    const summary = await runAnchorTick(
      50,
      deps({
        fetchQueue: () =>
          Promise.resolve([{ anchorQuery: "Azuro Hold Tight", trackId: "mb_hold" }]),
        report: (trackId, candidates) => {
          posted.push({ candidates, trackId });

          return Promise.resolve({ anchored: false, verifiedBy: null });
        },
        runActor: () =>
          Promise.resolve([
            APIFY_SAMPLE[0],
            {
              // The durationless shape: the actor answered for the query, but the item carries no
              // `track_duration_ms` — `itemToCandidate` normalizes it to `durationMs: null`.
              artists: [{ artist_name: "Azuro" }],
              error: null,
              success: true,
              target: "Azuro Hold Tight",
              tracks: [
                {
                  track_id: "3durationlessTrackId00",
                  track_isrc: "QZK6L2216561",
                  track_name: "Hold Tight - Extended",
                },
              ],
            },
          ]),
      }),
    );

    expect(summary.apifyDurationMsOmitted).toBe(1);
    // BEHAVIOUR IS UNCHANGED — both candidates still reach the Worker, the durationless one with
    // its normalized `durationMs: null`, and the row is still a clean miss. The counter measures
    // the class, it does not act on it.
    expect(posted.length).toBe(1);
    expect(posted[0].trackId).toBe("mb_hold");
    expect(posted[0].candidates.map((candidate) => candidate.durationMs)).toEqual([319_112, null]);
    expect(summary.missed).toBe(1);
    // Distinct from the blackout tell: the actor DID answer for this query.
    expect(summary.apifyTargetOmitted).toBe(0);
  });

  test("counts Deezer hits withheld for a missing gate signal", async () => {
    const summary = await runAnchorTick(
      50,
      deps({
        fetchQueue: () =>
          Promise.resolve([
            { anchorQuery: "q", deezerQuery: 'artist:"A" track:"B"', trackId: "mb_isrcless" },
          ]),
        report: () => Promise.resolve({ anchored: false, verifiedBy: null }),
        runActor: () => Promise.resolve([]),
        searchDeezer: () => Promise.resolve({ candidates: [], droppedIncomplete: 3 }),
      }),
    );

    expect(summary.deezerHitsDroppedIncomplete).toBe(3);
    // Withholding is not failing: the row resolved normally, just unhelped.
    expect(summary.deezerSearchFailed).toBe(0);
    expect(summary.failed).toBe(0);
  });

  test("still accepts the bare-array Deezer shape (nothing to report)", async () => {
    const sent: unknown[] = [];
    const summary = await runAnchorTick(
      50,
      deps({
        fetchQueue: () =>
          Promise.resolve([
            { anchorQuery: "q", deezerQuery: 'artist:"A" track:"B"', trackId: "mb_isrcless" },
          ]),
        report: () => Promise.resolve({ anchored: false, verifiedBy: null }),
        resolveFree: (_trackId, deezerCandidates) => {
          sent.push(deezerCandidates);

          return Promise.resolve({ anchored: false, verifiedBy: null });
        },
        runActor: () => Promise.resolve([]),
        searchDeezer: () =>
          Promise.resolve([
            { artistName: "A", durationMs: 1000, isrc: "GB0000000001", title: "B" },
          ]),
      }),
    );

    expect(sent).toEqual([
      [{ artistName: "A", durationMs: 1000, isrc: "GB0000000001", title: "B" }],
    ]);
    expect(summary.deezerHitsDroppedIncomplete).toBe(0);
  });
});

// ── THE NIGHT WINDOW (pure) ──────────────────────────────────────────────────────────────────────
describe("parseIsrcAskWindow / withinIsrcAskWindow", () => {
  const at = (hourUtc: number) => new Date(Date.UTC(2026, 7, 2, hourUtc, 30, 0));

  test("`0-8` is 00:00 inclusive to 08:00 EXCLUSIVE", () => {
    const window = parseIsrcAskWindow("0-8");

    expect(window).toEqual({ endHour: 8, startHour: 0 });
    expect(withinIsrcAskWindow(window, at(0))).toBe(true);
    expect(withinIsrcAskWindow(window, at(7))).toBe(true);
    expect(withinIsrcAskWindow(window, at(8))).toBe(false);
    expect(withinIsrcAskWindow(window, at(23))).toBe(false);
  });

  test("an EMPTY value is `always` — no window at all", () => {
    expect(parseIsrcAskWindow("")).toBe("always");
    expect(parseIsrcAskWindow(undefined)).toBe("always");
    expect(withinIsrcAskWindow("always", at(13))).toBe(true);
  });

  test("a start past its end WRAPS across midnight", () => {
    const window = parseIsrcAskWindow("22-6");

    expect(withinIsrcAskWindow(window, at(23))).toBe(true);
    expect(withinIsrcAskWindow(window, at(2))).toBe(true);
    expect(withinIsrcAskWindow(window, at(6))).toBe(false);
    expect(withinIsrcAskWindow(window, at(12))).toBe(false);
  });

  test("a malformed value DENIES — the breaker's default-deny discipline", () => {
    for (const raw of ["nonsense", "0-", "-8", "0-8-9", "24-30", "9pm-6am"]) {
      expect(parseIsrcAskWindow(raw)).toBe("invalid");
    }

    expect(withinIsrcAskWindow("invalid", at(3))).toBe(false);
  });

  test("a degenerate range (start === end) is an EMPTY window, never an all-day one", () => {
    // An operator who means `always` writes the empty string. The range is read literally.
    expect(withinIsrcAskWindow(parseIsrcAskWindow("4-4"), at(4))).toBe(false);
  });
});

describe("spotifyAskDeferral — which guard fired", () => {
  const night = new Date(Date.UTC(2026, 7, 2, 3, 0, 0));
  const day = new Date(Date.UTC(2026, 7, 2, 15, 0, 0));

  test("null when every guard is clear", () => {
    expect(spotifyAskDeferral(newSpotifyAskState(25, "0-8"), night)).toBeNull();
  });

  test("the yield law wins over the clock and the budget", () => {
    const state = { ...newSpotifyAskState(0, "0-8"), yielded: true };

    expect(spotifyAskDeferral(state, day)).toBe("yield");
  });

  test("the clock is asked before the budget", () => {
    const state = { ...newSpotifyAskState(0, "0-8"), asksSpent: 99 };

    expect(spotifyAskDeferral(state, day)).toBe("window");
  });

  test("a spent budget defers inside the window", () => {
    const state = { ...newSpotifyAskState(2, "0-8"), asksSpent: 2 };

    expect(spotifyAskDeferral(state, night)).toBe("budget");
  });

  test("a limit of 0 defers everything (the operator's off switch for the exact rung)", () => {
    expect(spotifyAskDeferral(newSpotifyAskState(0, ""), day)).toBe("budget");
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

    expect(await searchDeezerOnBox('artist:"Calibre" track:"Mr Right On"')).toEqual({
      candidates: [
        { artistName: "Calibre", durationMs: 132_000, isrc: "GBEXH1900314", title: "Mr Right On" },
      ],
      droppedIncomplete: 0,
    });
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

    const result = await searchDeezerOnBox("q");

    expect(result?.candidates.map((hit) => hit.isrc)).toEqual(["GBEXH1900314"]);
    // …AND SAYS SO. Four hits were withheld; without the count this response and a genuinely empty
    // one both leave as `[]`, so an upstream change that stripped `isrc` would read as "Deezer has
    // never heard of this catalogue" instead of as the regression it is.
    expect(result?.droppedIncomplete).toBe(4);
  });

  test("an empty result set is an honest miss (no candidates, nothing dropped), NOT a failure", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(Response.json({ data: [] }))) as typeof globalThis.fetch;

    expect(await searchDeezerOnBox("q")).toEqual({ candidates: [], droppedIncomplete: 0 });
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

    expect((await searchDeezerOnBox("q", [0, 0]))?.candidates.length).toBe(1);
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

  test("carries the durationless-candidate tally across pages", async () => {
    const base = pagedDeps([rows("a", 2), rows("b", 2)]);
    const summary = await runAnchorSweep(
      4,
      {
        ...base,
        resolveFree: () => Promise.resolve({ anchored: false, verifiedBy: null }),
        // Every query gets one candidate with no `track_duration_ms` — 2 per page, 4 in the sweep.
        runActor: (queries) =>
          Promise.resolve(
            queries.map((query) => ({
              success: true,
              target: query,
              tracks: [{ track_id: `id-${query}` }],
            })),
          ),
      },
      2,
    );

    expect(summary.pages).toBe(2);
    expect(summary.apifyDurationMsOmitted).toBe(4);
  });

  test("carries the free-rung durationless-candidate tally across pages", async () => {
    const base = pagedDeps([rows("a", 2), rows("b", 2)]);
    const summary = await runAnchorSweep(
      4,
      {
        ...base,
        resolveFree: () =>
          Promise.resolve({
            anchored: true,
            freeDurationMsOmitted: 1,
            source: "spotify-search",
            verifiedBy: "search",
          }),
      },
      2,
    );

    expect(summary.pages).toBe(2);
    expect(summary.freeDurationMsOmitted).toBe(4);
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

  test("a page the Worker defers after measured pages pauses the firing as partial, not failed", async () => {
    const { DueWorkRepairPendingError } = await import("./due-work-repair-pending");
    const deps = pagedDeps([rows("a", 2)]);
    let call = 0;
    const deferred: AnchorDeps = {
      ...deps,
      fetchQueue: (limit) => {
        call += 1;

        return call === 1
          ? deps.fetchQueue(limit)
          : Promise.reject(new DueWorkRepairPendingError("anchor queue read"));
      },
    };
    const summary = await runAnchorSweep(10, deferred, 2);

    expect(call).toBe(2);
    expect(summary).toMatchObject({
      errors: 0,
      gateState: "paused",
      ok: true,
      pages: 2,
      partial: true,
      pulled: 2,
      reason: "due_work_repair_pending",
      throttled: true,
    });
    expect(summary.error).toBeNull();
  });

  test("a first page the Worker defers pauses with nothing measured", async () => {
    const { DueWorkRepairPendingError } = await import("./due-work-repair-pending");
    const deferred: AnchorDeps = {
      ...pagedDeps([]),
      fetchQueue: () => Promise.reject(new DueWorkRepairPendingError("anchor queue read")),
    };
    const summary = await runAnchorSweep(10, deferred, 2);

    expect(summary).toMatchObject({
      checked: 0,
      errors: 0,
      gateState: "paused",
      ok: true,
      pages: 1,
      partial: false,
      produced: 0,
      queueDepth: null,
    });
  });
});

/** The verdict fields the admission-gate tests override. */
type AnchorVerdictShape = Awaited<ReturnType<AnchorDeps["resolveFree"]>>;

// ── THE PAID RUNG'S ADMISSION RULE, box side ─────────────────────────────────────────────────────
//
// The server decides whether a row may cost money and says so on the verdict; the sweep obeys. These
// pin both sides of that gate, plus the firing-level preflight that keeps an out-of-window tick from
// re-reading a queue head it cannot conclude anything about.

describe("anchorFiringDeferral", () => {
  const OPEN: AnchorPreflight = {
    apifyBudgetRemaining: 300,
    apifyBudgetSpent: false,
    apifyEnabled: true,
    spotifySearchEnabled: true,
  };
  const IN_WINDOW = new Date("2026-09-20T03:00:00Z");
  const OUT_OF_WINDOW = new Date("2026-09-20T12:00:00Z");
  const NIGHT = parseIsrcAskWindow("0-8");

  test("inside the night window the firing pulls work", () => {
    expect(anchorFiringDeferral(OPEN, NIGHT, IN_WINDOW)).toBeNull();
  });

  test("outside it, with both rungs armed, the firing pulls NOTHING", () => {
    // Every row it could reach would want a free ask this tick cannot make, so pulling them only
    // re-reads the queue head — the churn the admission rule would otherwise reintroduce.
    expect(anchorFiringDeferral(OPEN, NIGHT, OUT_OF_WINDOW)).toBe("awaiting_free_ask");
  });

  test("a spent daily cap stops the firing whatever the clock says", () => {
    expect(anchorFiringDeferral({ ...OPEN, apifyBudgetSpent: true }, NIGHT, IN_WINDOW)).toBe(
      "apify_budget_spent",
    );
  });

  test("with the free search rungs DISARMED the firing always pulls — the load-bearing case", () => {
    // No receipt can ever be written then, so the admission rule exempts every row and the sweep
    // must drain exactly as it did before the rule existed.
    expect(
      anchorFiringDeferral({ ...OPEN, spotifySearchEnabled: false }, NIGHT, OUT_OF_WINDOW),
    ).toBeNull();
  });

  test("with the kill-flag OFF there is no money to protect, so the firing pulls", () => {
    expect(
      anchorFiringDeferral(
        { ...OPEN, apifyBudgetSpent: true, apifyEnabled: false },
        NIGHT,
        OUT_OF_WINDOW,
      ),
    ).toBeNull();
  });

  test('an empty window ("always") never defers on the clock', () => {
    expect(anchorFiringDeferral(OPEN, parseIsrcAskWindow(""), OUT_OF_WINDOW)).toBeNull();
  });

  test("the escape hatch turns every deferral into a free-rungs-only firing", () => {
    // `FLUNCLE_ANCHOR_DAY_FREE_RUNGS=1`: pull the batch, run the free rungs, spend nothing. Both
    // deferral causes convert, so the knob reverses the whole tradeoff rather than half of it.
    expect(anchorFiringDeferral(OPEN, NIGHT, OUT_OF_WINDOW, true)).toBe("free_rungs_only");
    expect(anchorFiringDeferral({ ...OPEN, apifyBudgetSpent: true }, NIGHT, IN_WINDOW, true)).toBe(
      "free_rungs_only",
    );
  });

  test("the escape hatch changes nothing about a firing that was already going to run", () => {
    expect(anchorFiringDeferral(OPEN, NIGHT, IN_WINDOW, true)).toBeNull();
    expect(
      anchorFiringDeferral({ ...OPEN, spotifySearchEnabled: false }, NIGHT, OUT_OF_WINDOW, true),
    ).toBeNull();
  });
});

describe("runAnchorTick — the admission gate", () => {
  function gateDeps(
    eligible: (trackId: string) => Partial<AnchorVerdictShape>,
    onActor?: () => void,
  ): AnchorDeps {
    return {
      fetchQueue: () =>
        Promise.resolve([
          { anchorQuery: "Azuro Hold Tight", trackId: "mb_hold" },
          { anchorQuery: "Technimatic For All of Us", trackId: "mb_fau" },
        ]),
      log: () => {},
      now: () => 0,
      report: () => Promise.resolve({ anchored: false, verifiedBy: null }),
      resolveFree: (trackId) =>
        Promise.resolve({ anchored: false, verifiedBy: null, ...eligible(trackId) }),
      runActor: () => {
        onActor?.();

        return Promise.resolve(APIFY_SAMPLE);
      },
      searchDeezer: () => Promise.resolve([]),
      sleep: () => Promise.resolve(),
    };
  }

  test("an un-admitted row is DEFERRED, never sent to the actor and never counted as missed", async () => {
    let actorRuns = 0;
    const summary = await runAnchorTick(
      50,
      gateDeps(
        () => ({ apifyEligible: false, apifyIneligibleReason: "awaiting_free_ask" }),
        () => {
          actorRuns += 1;
        },
      ),
    );

    expect(actorRuns).toBe(0);
    expect(summary.apifyRowsSent).toBe(0);
    expect(summary.apifySkippedAwaitingSpotify).toBe(2);
    expect(summary.deferred).toBe(2);
    // `missed` means RETIRED. Nothing was asked about these rows, so nothing was settled.
    expect(summary.missed).toBe(0);
    expect(summary.ok).toBe(true);
  });

  test("a budget refusal has its own counter, so the two causes never blur", async () => {
    const summary = await runAnchorTick(
      50,
      gateDeps(() => ({
        apifyBudgetRemaining: 0,
        apifyEligible: false,
        apifyIneligibleReason: "apify_budget_spent",
      })),
    );

    expect(summary.apifyBudgetSkipped).toBe(2);
    expect(summary.apifySkippedAwaitingSpotify).toBe(0);
    expect(summary.apifyBudgetRemaining).toBe(0);
  });

  test("an ADMITTED row still spends the actor, and the ledger counts rows AND result items", async () => {
    const summary = await runAnchorTick(
      50,
      gateDeps(() => ({ apifyBudgetRemaining: 42, apifyEligible: true })),
    );

    expect(summary.apifyRowsSent).toBe(2);
    // The actor bills per RESULT ITEM, so the ledger carries items, not runs.
    expect(summary.apifyResults).toBe(APIFY_SAMPLE.length);
    expect(summary.apifyBudgetRemaining).toBe(42);
    expect(summary.deferred).toBe(0);
  });

  test("a server that reports NO verdict admits the row (new sweep, old Worker)", async () => {
    const summary = await runAnchorTick(
      50,
      gateDeps(() => ({})),
    );

    // Version tolerance runs both ways: a Worker with no admission rule has no verdict to give, and
    // the sweep must not invent one on its behalf.
    expect(summary.apifyRowsSent).toBe(2);
    expect(summary.apifySkippedAwaitingSpotify).toBe(0);
  });

  test("one admitted and one refused row split cleanly", async () => {
    const posted: string[] = [];
    const deps = gateDeps((trackId) => ({
      apifyEligible: trackId === "mb_hold",
      apifyIneligibleReason: trackId === "mb_hold" ? null : "awaiting_free_ask",
    }));
    const summary = await runAnchorTick(50, {
      ...deps,
      report: (trackId) => {
        posted.push(trackId);

        return Promise.resolve({ anchored: false, verifiedBy: null });
      },
    });

    expect(posted).toEqual(["mb_hold"]);
    expect(summary.apifySkippedAwaitingSpotify).toBe(1);
    expect(summary.deferred).toBe(1);
  });
});

describe("runAnchorSweep — the firing preflight", () => {
  function preflightDeps(
    preflight: AnchorPreflight | (() => Promise<AnchorPreflight>),
    onFetch: () => void,
  ): AnchorDeps {
    return {
      fetchQueue: () => {
        onFetch();

        return Promise.resolve([{ anchorQuery: "q", trackId: "mb_a" }]);
      },
      log: () => {},
      // 12:00 UTC — outside the default "0-8" night window.
      now: () => Date.parse("2026-09-20T12:00:00Z"),
      readPreflight: typeof preflight === "function" ? preflight : () => Promise.resolve(preflight),
      report: () => Promise.resolve({ anchored: false, verifiedBy: null }),
      resolveFree: () =>
        Promise.resolve({ anchored: false, apifyEligible: true, verifiedBy: null }),
      runActor: () => Promise.resolve([]),
      searchDeezer: () => Promise.resolve([]),
      sleep: () => Promise.resolve(),
    };
  }

  test("a deferred firing reads NO worklist page at all", async () => {
    let fetches = 0;
    const summary = await runAnchorSweep(
      15,
      preflightDeps(
        {
          apifyBudgetRemaining: 300,
          apifyBudgetSpent: false,
          apifyEnabled: true,
          spotifySearchEnabled: true,
        },
        () => {
          fetches += 1;
        },
      ),
    );

    expect(fetches).toBe(0);
    expect(summary.reason).toBe("awaiting_free_ask");
    expect(summary.checked).toBe(0);
    // It measured nothing, so it claims nothing about the backlog.
    expect(summary.queueDepth).toBeNull();
    expect(summary.apifyBudgetRemaining).toBe(300);
    expect(summary.ok).toBe(true);
  });

  test("a spent cap defers the firing with its own reason", async () => {
    const summary = await runAnchorSweep(
      15,
      preflightDeps(
        {
          apifyBudgetRemaining: 0,
          apifyBudgetSpent: true,
          apifyEnabled: true,
          spotifySearchEnabled: false,
        },
        () => {},
      ),
    );

    expect(summary.reason).toBe("apify_budget_spent");
  });

  test("a preflight that THROWS is fail-open — the firing runs as it always did", async () => {
    let fetches = 0;
    const summary = await runAnchorSweep(
      1,
      preflightDeps(
        () => Promise.reject(new Error("breaker read 503")),
        () => {
          fetches += 1;
        },
      ),
    );

    // The admission rule is enforced server-side on every row regardless, so a blip here must cost a
    // wasted tick at worst, never a stalled drain.
    expect(fetches).toBe(1);
    expect(summary.reason).toBeNull();
    expect(summary.checked).toBe(1);
  });

  test("an ARMED firing never pulls more rows than the tick can ask about", async () => {
    const asked: number[] = [];
    const summary = await runAnchorSweep(1_000, {
      ...preflightDeps(
        {
          apifyBudgetRemaining: 300,
          apifyBudgetSpent: false,
          apifyEnabled: true,
          spotifySearchEnabled: true,
        },
        () => {},
      ),
      fetchQueue: (limit) => {
        asked.push(limit);

        return Promise.resolve([]);
      },
      now: () => Date.parse("2026-09-20T03:00:00Z"),
    });

    // A row only leaves this queue after the exact-ISRC rung has asked about it, and the tick may
    // ask `ISRC_ASK_LIMIT` times — pulling more hands the surplus a pass that can conclude nothing.
    expect(asked).toEqual([newSpotifyAskState().limit]);
    expect(summary.ok).toBe(true);
  });

  test("a DISARMED firing pulls the operator's whole batch", async () => {
    const asked: number[] = [];
    await runAnchorSweep(1_000, {
      ...preflightDeps(
        {
          apifyBudgetRemaining: 300,
          apifyBudgetSpent: false,
          apifyEnabled: true,
          spotifySearchEnabled: false,
        },
        () => {},
      ),
      fetchQueue: (limit) => {
        asked.push(limit);

        return Promise.resolve([]);
      },
    });

    // Disarmed, every row is admitted on sight, so the cap must not bind (200 is the page limit).
    expect(asked).toEqual([200]);
  });

  test("a deferred firing NAMES the rungs it skipped, including the free ones", async () => {
    const summary = await runAnchorSweep(
      15,
      preflightDeps(
        {
          apifyBudgetRemaining: 300,
          apifyBudgetSpent: false,
          apifyEnabled: true,
          spotifySearchEnabled: true,
        },
        () => {},
      ),
    );

    // `checked: 0` alone reads like an empty queue. The ledger has to say the two FREE rungs did
    // not run either, or a later reader infers a drained backlog from a firing that pulled nothing.
    expect(summary.rungsSkipped).toEqual([
      "listenbrainz",
      "deezer-isrc-recovery",
      "spotify-search",
      "apify",
    ]);
  });

  test("free-rungs-only: the batch is pulled and resolved, the actor never runs, rows keep their turn", async () => {
    let actorRuns = 0;
    let posted = 0;
    const summary = await runAnchorTick(
      50,
      {
        fetchQueue: () =>
          Promise.resolve([
            { anchorQuery: "Azuro Hold Tight", trackId: "mb_hold" },
            { anchorQuery: "Technimatic For All of Us", trackId: "mb_fau" },
          ]),
        log: () => {},
        now: () => 0,
        report: () => {
          posted += 1;

          return Promise.resolve({ anchored: false, verifiedBy: null });
        },
        resolveFree: (trackId) =>
          Promise.resolve(
            trackId === "mb_hold"
              ? { anchored: true, source: "listenbrainz", verifiedBy: "isrc" }
              : { anchored: false, apifyEligible: true, verifiedBy: null },
          ),
        runActor: () => {
          actorRuns += 1;

          return Promise.resolve([]);
        },
        searchDeezer: () => Promise.resolve([]),
        sleep: () => Promise.resolve(),
      },
      15,
      newSpotifyAskState(),
      true,
    );

    // The FREE rung still wins what it can — that is the entire point of the escape hatch.
    expect(summary.anchoredByListenbrainz).toBe(1);
    expect(summary.produced).toBe(1);
    // …and the paid leg is untouched: no actor run, no POST, and the miss is DEFERRED not MISSED.
    expect(actorRuns).toBe(0);
    expect(posted).toBe(0);
    expect(summary.apifyRowsSent).toBe(0);
    expect(summary.deferred).toBe(1);
    expect(summary.missed).toBe(0);
    expect(summary.rungsSkipped).toEqual(["apify"]);
  });

  test("an armed, in-window firing pulls normally", async () => {
    let fetches = 0;
    const deps = preflightDeps(
      {
        apifyBudgetRemaining: 300,
        apifyBudgetSpent: false,
        apifyEnabled: true,
        spotifySearchEnabled: true,
      },
      () => {
        fetches += 1;
      },
    );
    const summary = await runAnchorSweep(1, {
      ...deps,
      now: () => Date.parse("2026-09-20T03:00:00Z"),
    });

    expect(fetches).toBe(1);
    expect(summary.reason).toBeNull();
  });
});
