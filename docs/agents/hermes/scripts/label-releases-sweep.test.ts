// Unit tests for label-releases-sweep.ts — the FRESHNESS TAP cron's orchestrator (D8).
//
// The box only maps the actor's albums → candidates + POSTs them; the Worker verifies (grounds,
// attributes, dedupes, mints). So the contract worth pinning here is the box's MAPPING and the tick's
// tally + fault handling. The fixture is the REAL shape the actor returns for
// `albums:["label:\"<name>\" tag:new"]` (verified live): ONE dataset item PER album, the album
// metadata NESTED in `item.albums[0]`, its `tracks[]` (w/ ISRC) + `artists[]` at the item's TOP level;
// `album_label`/`album_copyright` NULL in this mode. The NESTING is load-bearing — the first cut read
// `item.album_*` at top level and always got `undefined`, minting /fresh-invisible null-date rows.
//
// Runs outside any package's test runner (bun:test), like anchor-sweep.test.ts:
//   bun test docs/agents/hermes/scripts/label-releases-sweep.test.ts

import { describe, expect, test } from "bun:test";
import {
  albumItemToCandidate,
  type ApifyAlbumItem,
  type LabelReleasesDeps,
  mapAlbumItems,
  type MintVerdict,
  parseLimitArg,
  runLabelReleasesTick,
} from "./label-releases-sweep";

// The REAL actor shape (verified live): ONE dataset item PER album, the album metadata NESTED in
// `albums[0]`, its `tracks[]` (+ ISRCs) + `artists[]` at the item's TOP level. `album_label`/
// `album_copyright` come back NULL in the `albums`-search mode — the Worker gates on grounding there.
const APIFY_SAMPLE: ApifyAlbumItem[] = [
  {
    albums: [
      {
        album_copyright: null,
        album_id: "3alb1",
        album_label: null,
        album_name: "New EP",
        album_release_date: "2026-07-19",
        album_total_tracks: 1,
        album_upc: "5054960000001",
      },
    ],
    artists: [{ artist_id: "29rsvX8tM1cbyZhn554CFk", artist_name: "Keeno" }],
    error: null,
    mode: "keyword",
    result: "1/3",
    success: true,
    target: 'label:"Hospital Records" tag:new',
    tracks: [
      {
        track_duration_ms: 319_112,
        track_id: "0RceyuivB4augSTMbNLKfw",
        track_isrc: "QZK6L2216560",
        track_name: "Sundialer",
        track_uri: "spotify:track:0RceyuivB4augSTMbNLKfw",
        track_url: "https://open.spotify.com/track/0RceyuivB4augSTMbNLKfw",
      },
    ],
    type: "album",
  },
  {
    albums: [{ album_id: "3alb2", album_name: "Another Single", album_release_date: "2026-07-18" }],
    // Artists present, but a track with no id is dropped; the good track survives.
    artists: [{ artist_id: "03JgNMfOmGHddbWkzlZ7n4", artist_name: "Bop" }],
    success: true,
    tracks: [
      { track_name: "no id — dropped" },
      {
        track_duration_ms: 210_000,
        track_id: "1bQvXpSuvnJqAAMkmEIwhu",
        track_isrc: "QT3EY2633906",
        track_name: "Skankin",
      },
    ],
    type: "album",
  },
];

describe("albumItemToCandidate", () => {
  test("reads the NESTED album (albums[0]) + the item-level tracks/artists", () => {
    expect(albumItemToCandidate(APIFY_SAMPLE[0])).toEqual({
      albumCopyright: null,
      albumId: "3alb1",
      albumLabel: null,
      albumName: "New EP",
      artists: [{ id: "29rsvX8tM1cbyZhn554CFk", name: "Keeno" }],
      releaseDate: "2026-07-19",
      tracks: [
        {
          durationMs: 319_112,
          isrc: "QZK6L2216560",
          spotifyTrackId: "0RceyuivB4augSTMbNLKfw",
          title: "Sundialer",
          uri: "spotify:track:0RceyuivB4augSTMbNLKfw",
          url: "https://open.spotify.com/track/0RceyuivB4augSTMbNLKfw",
        },
      ],
    });
  });

  test("drops a track with no id, keeps the album when at least one survives", () => {
    const candidate = albumItemToCandidate(APIFY_SAMPLE[1]);

    expect(candidate?.albumId).toBe("3alb2"); // read from the nested albums[0]
    expect(candidate?.releaseDate).toBe("2026-07-18");
    expect(candidate?.tracks.map((track) => track.spotifyTrackId)).toEqual([
      "1bQvXpSuvnJqAAMkmEIwhu",
    ]);
    // The missing uri/url default to null (the Worker derives them from the id).
    expect(candidate?.tracks[0]?.uri).toBeNull();
    expect(candidate?.tracks[0]?.url).toBeNull();
    // The absent album_label/copyright default to null (grounding-only mode).
    expect(candidate?.albumLabel).toBeNull();
    expect(candidate?.albumCopyright).toBeNull();
  });

  test("DROPS an item with a nested album but NO release_date (a /fresh-invisible row)", () => {
    // The album exists, the tracks are good — but a null release_date means the minted row could
    // never surface on /fresh, so it must never be POSTed.
    const item: ApifyAlbumItem = {
      albums: [{ album_id: "x", album_name: "Dateless" /* no album_release_date */ }],
      artists: [{ artist_id: "a", artist_name: "Someone" }],
      success: true,
      tracks: [{ track_id: "t", track_isrc: "GB0000000009", track_name: "Song" }],
    };

    expect(albumItemToCandidate(item)).toBeNull();
  });

  test("returns null for a failed item, no albums[], or no usable track", () => {
    expect(albumItemToCandidate({ success: false })).toBeNull();
    // Tracks present but NO nested album at all → drop (the old flat-shape bug looked like this).
    expect(
      albumItemToCandidate({ success: true, tracks: [{ track_id: "t", track_name: "x" }] }),
    ).toBeNull();
    // A dated album but no usable track → drop.
    expect(
      albumItemToCandidate({
        albums: [{ album_id: "x", album_release_date: "2026-07-19" }],
        success: true,
        tracks: [{ track_name: "no id" }],
      }),
    ).toBeNull();
  });

  test("passes a nested album_label/copyright signal through when the actor gives one", () => {
    const candidate = albumItemToCandidate({
      albums: [
        {
          album_copyright: "℗ 2026 Hospital Records",
          album_id: "a",
          album_label: "Hospital Records",
          album_release_date: "2026-07-19",
        },
      ],
      artists: [{ artist_id: "x", artist_name: "London Elektricity" }],
      success: true,
      tracks: [{ track_id: "t", track_name: "Song" }],
    });

    expect(candidate?.albumLabel).toBe("Hospital Records");
    expect(candidate?.albumCopyright).toBe("℗ 2026 Hospital Records");
  });
});

describe("mapAlbumItems / parseLimitArg", () => {
  test("maps a multi-item run to multiple candidates, dropping the unusable ones", () => {
    const items: ApifyAlbumItem[] = [
      ...APIFY_SAMPLE,
      { success: true, tracks: [{ track_name: "trackless" }] }, // no album, no track id → dropped
    ];

    expect(mapAlbumItems(items).map((album) => album.albumId)).toEqual(["3alb1", "3alb2"]);
  });

  test("parseLimitArg reads --limit N, else the fallback", () => {
    expect(parseLimitArg(["--limit", "20"], 5)).toBe(20);
    expect(parseLimitArg([], 5)).toBe(5);
    expect(parseLimitArg(["--limit", "-3"], 5)).toBe(5);
  });
});

describe("runLabelReleasesTick", () => {
  const VERDICT: MintVerdict = {
    albumsMatched: 1,
    albumsSeen: 2,
    found: true,
    newRows: 1,
    skippedKnown: 0,
    skippedUnattributed: 0,
    skippedUngrounded: 1,
  };

  function deps(overrides: Partial<LabelReleasesDeps> = {}): LabelReleasesDeps {
    return {
      fetchQueue: () =>
        Promise.resolve([
          { name: "Keeno Music", slug: "keeno-music" },
          { name: "Med School", slug: "medschool" },
        ]),
      log: () => {},
      report: () => Promise.resolve(VERDICT),
      runActor: () => Promise.resolve(APIFY_SAMPLE),
      ...overrides,
    };
  }

  test("runs the actor per label, POSTs mapped candidates, and accumulates the verdicts", async () => {
    const posted: Record<string, number> = {};
    const summary = await runLabelReleasesTick(
      5,
      deps({
        report: (labelSlug, candidates) => {
          posted[labelSlug] = candidates.length;

          return Promise.resolve(VERDICT);
        },
      }),
    );

    expect(summary.ok).toBe(true);
    expect(summary.labelsProbed).toBe(2);
    expect(summary.albumsSeen).toBe(4); // 2 labels × the verdict's 2
    expect(summary.albumsMatched).toBe(2);
    expect(summary.newRows).toBe(2);
    expect(summary.skippedUngrounded).toBe(2);
    // Each label's actor result mapped to two candidate albums.
    expect(posted).toEqual({ "keeno-music": 2, medschool: 2 });
  });

  test("skips a worklist row missing a slug or name", async () => {
    const summary = await runLabelReleasesTick(
      5,
      deps({
        fetchQueue: () => Promise.resolve([{ slug: "no-name" }, { name: "orphan" }]),
      }),
    );

    expect(summary.skipped).toBe(2);
    expect(summary.labelsProbed).toBe(0);
  });

  test("a label whose actor run throws is counted failed, and the tick keeps draining", async () => {
    let calls = 0;
    const summary = await runLabelReleasesTick(
      5,
      deps({
        runActor: () => {
          calls += 1;

          return calls === 1
            ? Promise.reject(new Error("apify 500"))
            : Promise.resolve(APIFY_SAMPLE);
        },
      }),
    );

    expect(summary.failedLabels).toBe(1);
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("apify 500");
    // The SECOND label still probed — one label's actor failure never aborts the tick.
    expect(summary.labelsProbed).toBe(1);
  });

  test("a POST that throws counts the label skipped, never aborts the tick", async () => {
    const summary = await runLabelReleasesTick(
      5,
      deps({ report: () => Promise.reject(new Error("worker 502")) }),
    );

    expect(summary.skipped).toBe(2);
    expect(summary.labelsProbed).toBe(0);
    expect(summary.ok).toBe(true); // a report throw is per-label, not a tick fault
  });

  test("a failed worklist fetch reports ok:false, not a throw", async () => {
    const summary = await runLabelReleasesTick(
      5,
      deps({ fetchQueue: () => Promise.reject(new Error("queue down")) }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("queue down");
  });
});
