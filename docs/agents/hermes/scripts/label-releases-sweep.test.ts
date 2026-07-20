// Unit tests for label-releases-sweep.ts — the FRESHNESS TAP cron's orchestrator (D8).
//
// The box only maps the actor's albums → candidates + POSTs them; the Worker verifies (grounds,
// attributes, dedupes, mints). So the contract worth pinning here is the box's MAPPING (the actor's
// `albums`-search result item → a candidate album with its inline tracks + artists + album fields)
// and the tick's tally + fault handling. The fixture is the shape the real actor returns for
// `albums:["label:\"<name>\" tag:new"]` (album fields + tracks[] w/ ISRC + artists[]; label/copyright
// NULL in this mode, measured live 2026-07-20).
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

// A representative slice of the actor's `albums`-search output: two fresh albums for one label. Each
// album carries album fields + a top-level `artists[]` + inline `tracks[]` (with ISRC). `album_label`
// / `album_copyright` are NULL in this mode — the Worker gates on artist-grounding there.
const APIFY_SAMPLE: ApifyAlbumItem[] = [
  {
    album_copyright: null,
    album_id: "3alb1",
    album_label: null,
    album_name: "New EP",
    album_release_date: "2026-07-19",
    artists: [{ artist_id: "29rsvX8tM1cbyZhn554CFk", artist_name: "Keeno" }],
    success: true,
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
  },
  {
    album_id: "3alb2",
    album_name: "Another Single",
    album_release_date: "2026-07-18",
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
  },
];

describe("albumItemToCandidate", () => {
  test("maps an album (fields, artists, inline tracks with isrc/uri/url)", () => {
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

  test("returns null for a failed item or an album with no usable track", () => {
    expect(albumItemToCandidate({ success: false, tracks: [] })).toBeNull();
    expect(albumItemToCandidate({ success: true, tracks: [{ track_name: "no id" }] })).toBeNull();
    expect(albumItemToCandidate({ success: true })).toBeNull();
  });

  test("passes an album_label/copyright signal through when the actor gives one", () => {
    const candidate = albumItemToCandidate({
      album_copyright: "℗ 2026 Hospital Records",
      album_id: "a",
      album_label: "Hospital Records",
      artists: [{ artist_id: "x", artist_name: "London Elektricity" }],
      success: true,
      tracks: [{ track_id: "t", track_name: "Song" }],
    });

    expect(candidate?.albumLabel).toBe("Hospital Records");
    expect(candidate?.albumCopyright).toBe("℗ 2026 Hospital Records");
  });
});

describe("mapAlbumItems / parseLimitArg", () => {
  test("mapAlbumItems keeps only the track-carrying albums", () => {
    const items: ApifyAlbumItem[] = [
      ...APIFY_SAMPLE,
      { success: true, tracks: [{ track_name: "trackless" }] },
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
