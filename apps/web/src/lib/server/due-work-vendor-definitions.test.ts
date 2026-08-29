import { describe, expect, it } from "vitest";

import {
  DEEZER_MAX_FAILURES,
  DUE_WORK_VENDOR_SOURCE_COLUMNS,
  DUE_WORK_VENDOR_WORK_KIND_INVENTORY,
  MBID_ISRC_REFRESH_AFTER_MS,
  VENDOR_COOLDOWN_BASE_MS,
  evaluateDueWorkVendorQueue,
  type DueWorkVendorKind,
  type DueWorkVendorSource,
} from "./due-work-vendor-definitions";

const NOW = "2026-08-26T12:00:00.000Z";

function source(overrides: Partial<DueWorkVendorSource> = {}): DueWorkVendorSource {
  return {
    addedToSpotify: false,
    appleMusicAttemptedAt: null,
    appleMusicDoneAt: null,
    appleMusicFailures: 0,
    appleMusicUrl: null,
    artistCreditsBackfilledAt: null,
    artistEdgesBackfilledAt: null,
    artists: ["Calibre"],
    beatportAttemptedAt: null,
    beatportDoneAt: null,
    beatportFailures: 0,
    beatportUrl: null,
    capturePriority: 1,
    captureStatus: null,
    captureVerification: null,
    catalogueRankCorpus: null,
    certified: false,
    deezerAttemptedAt: null,
    deezerFailures: 0,
    deezerTrackId: null,
    discogsAttemptedAt: null,
    discogsDoneAt: null,
    discogsFailures: 0,
    discogsReleaseUrl: null,
    dismissedAt: null,
    durationMs: 180_000,
    findingAddedAt: "2026-08-01T00:00:00.000Z",
    hasArtistEdge: true,
    hasEmbedding: false,
    isCatalogue: true,
    isrc: "GB-ABC-12-34567",
    isrcAttemptedAt: null,
    lastfmAttemptedAt: null,
    lastfmDoneAt: null,
    lastfmFailures: 0,
    mbRecordingId: null,
    mbRecordingIdAttemptedAt: null,
    postedToTelegram: false,
    sourceAudioKey: null,
    title: "Even If",
    trackId: "track-a",
    ...overrides,
  };
}

function queue(
  kind: DueWorkVendorKind,
  sources: readonly DueWorkVendorSource[],
  rankCorpus?: string,
) {
  return evaluateDueWorkVendorQueue({ kind, now: NOW, rankCorpus, sources });
}

describe("due-work vendor definitions", () => {
  it("keeps the source inventory and source type in lockstep", () => {
    expect([...DUE_WORK_VENDOR_SOURCE_COLUMNS].sort()).toEqual(Object.keys(source()).sort());
  });

  it("has one exact evaluator per physical selector", () => {
    const examples: ReadonlyArray<{
      kind: DueWorkVendorKind;
      rankCorpus?: string;
      row: DueWorkVendorSource;
    }> = [
      { kind: "catalogue-rank", rankCorpus: "v5:1", row: source() },
      { kind: "capture-verification", row: source({ sourceAudioKey: "audio" }) },
      { kind: "mbid-prefix-strip", row: source({ isrc: null, trackId: "mb_recording" }) },
      { kind: "mbid-isrc-lookup", row: source() },
      { kind: "mbid-isrc-refresh", row: source({ isrc: null, mbRecordingId: "recording" }) },
      {
        kind: "discogs-track",
        row: source({ addedToSpotify: true, certified: true, postedToTelegram: true }),
      },
      {
        kind: "lastfm-track",
        row: source({ addedToSpotify: true, certified: true, postedToTelegram: true }),
      },
      {
        kind: "apple-finding",
        row: source({ addedToSpotify: true, certified: true, postedToTelegram: true }),
      },
      { kind: "apple-catalogue", row: source() },
      {
        kind: "beatport-finding",
        row: source({ addedToSpotify: true, certified: true, postedToTelegram: true }),
      },
      { kind: "beatport-catalogue", row: source() },
      { kind: "deezer-finding", row: source({ certified: true }) },
      { kind: "deezer-catalogue", row: source() },
      {
        kind: "artist-credits",
        row: source({ artistEdgesBackfilledAt: NOW, hasArtistEdge: false }),
      },
      { kind: "artist-edges", row: source({ hasArtistEdge: false }) },
    ];
    expect(examples.map((example) => example.kind).sort()).toEqual(
      DUE_WORK_VENDOR_WORK_KIND_INVENTORY.map((entry) => entry.workKind).sort(),
    );
    for (const example of examples) {
      expect(
        queue(example.kind, [example.row], example.rankCorpus).map((row) => row.trackId),
        example.kind,
      ).toEqual([example.row.trackId]);
    }
  });

  it("keeps the catalogue-rank stale predicate, its re-embed exception, and its id order", () => {
    const rows = queue(
      "catalogue-rank",
      [
        source({ trackId: "b" }),
        source({
          capturePriority: -1,
          catalogueRankCorpus: "v5:1",
          hasEmbedding: true,
          trackId: "stable-negative",
        }),
        source({
          capturePriority: 0,
          catalogueRankCorpus: "v5:1",
          hasEmbedding: true,
          trackId: "re-embed",
        }),
        source({ catalogueRankCorpus: "v5:1", dismissedAt: NOW, trackId: "dismissed" }),
        source({ catalogueRankCorpus: "v5:1", certified: true, trackId: "finding" }),
        source({ trackId: "a" }),
      ],
      "v5:1",
    );
    expect(rows.map((row) => row.trackId)).toEqual(["a", "b", "re-embed"]);
  });

  it("keeps verification certification-neutral and excludes only quarantined captures", () => {
    const rows = queue("capture-verification", [
      source({ certified: true, sourceAudioKey: "finding", trackId: "finding" }),
      source({ sourceAudioKey: "catalogue", trackId: "catalogue" }),
      source({ captureStatus: "wrong-audio", sourceAudioKey: "bad", trackId: "bad" }),
      source({ captureVerification: "match", sourceAudioKey: "done", trackId: "done" }),
    ]);
    expect(rows.map((row) => row.trackId)).toEqual(["catalogue", "finding"]);
  });

  it("uses the exact three MBID predicates and the twenty-one-day refresh boundary", () => {
    const exact = new Date(Date.parse(NOW) - MBID_ISRC_REFRESH_AFTER_MS).toISOString();
    expect(
      queue("mbid-prefix-strip", [
        source({ trackId: "mb_good" }),
        source({ mbRecordingIdAttemptedAt: NOW, trackId: "mb_attempted" }),
        source({ trackId: "spotify" }),
      ]).map((row) => row.trackId),
    ).toEqual(["mb_good"]);
    expect(
      queue("mbid-isrc-lookup", [
        source({ trackId: "spotify" }),
        source({ mbRecordingIdAttemptedAt: NOW, trackId: "attempted" }),
        source({ isrc: "", trackId: "blank" }),
        source({ isrc: " ", trackId: "whitespace" }),
        source({ trackId: "mb_crawler" }),
      ]).map((row) => row.trackId),
    ).toEqual(["spotify", "whitespace"]);
    expect(
      queue("mbid-isrc-refresh", [
        source({ isrc: null, isrcAttemptedAt: exact, mbRecordingId: "exact", trackId: "exact" }),
        source({
          isrc: null,
          isrcAttemptedAt: "2026-08-01T12:00:00.000Z",
          mbRecordingId: "old",
          trackId: "old",
        }),
        source({ isrc: "GB-ABC-12-34567", mbRecordingId: "has-isrc", trackId: "has-isrc" }),
      ]).map((row) => [row.trackId, row.nextDueAt]),
    ).toEqual([
      ["old", "2026-08-22T12:00:00.001Z"],
      ["exact", "2026-08-26T12:00:00.001Z"],
    ]);
  });

  it("preserves published-finding gates and the independently ordered catalogue legs", () => {
    const finding = source({ addedToSpotify: true, certified: true, postedToTelegram: true });
    expect(
      queue("discogs-track", [finding, source({ certified: true, postedToTelegram: true })]),
    ).toHaveLength(1);
    expect(
      queue("lastfm-track", [
        finding,
        source({ addedToSpotify: true, artists: [], certified: true, postedToTelegram: true }),
      ]),
    ).toHaveLength(1);
    expect(
      queue("apple-finding", [
        finding,
        source({ addedToSpotify: true, certified: true, isrc: "", postedToTelegram: true }),
      ]),
    ).toHaveLength(1);
    expect(
      queue("beatport-finding", [
        finding,
        source({ addedToSpotify: true, certified: true, isrc: "", postedToTelegram: true }),
      ]),
    ).toHaveLength(1);
    expect(
      queue("apple-catalogue", [
        source({ capturePriority: null, trackId: "null" }),
        source({ capturePriority: 0, trackId: "zero" }),
        source({ capturePriority: 3, trackId: "three" }),
      ]).map((row) => row.trackId),
    ).toEqual(["three", "zero", "null"]);
  });

  it("schedules vendor retries at the exact cooldown boundary and never returns done rows", () => {
    const exact = new Date(Date.parse(NOW) - VENDOR_COOLDOWN_BASE_MS).toISOString();
    const recent = "2026-08-26T11:00:00.000Z";
    const rows = queue("apple-finding", [
      source({
        addedToSpotify: true,
        appleMusicAttemptedAt: exact,
        certified: true,
        postedToTelegram: true,
        trackId: "exact",
      }),
      source({
        addedToSpotify: true,
        appleMusicAttemptedAt: recent,
        certified: true,
        postedToTelegram: true,
        trackId: "future",
      }),
      source({
        addedToSpotify: true,
        appleMusicDoneAt: "2026-01-01T00:00:00.000Z",
        certified: true,
        postedToTelegram: true,
        trackId: "done",
      }),
    ]);
    expect(rows.map((row) => [row.trackId, row.nextDueAt])).toEqual([
      ["future", "2026-08-27T11:00:00.000Z"],
      ["exact", NOW],
    ]);
  });

  it("keeps Beatport catalogue clean misses terminal while retrying failures with the scaled cooldown", () => {
    const rows = queue("beatport-catalogue", [
      source({
        beatportAttemptedAt: "2026-08-20T12:00:00.000Z",
        beatportFailures: 0,
        trackId: "clean-miss",
      }),
      source({
        beatportAttemptedAt: "2026-08-23T12:00:00.000Z",
        beatportFailures: 1,
        trackId: "retry",
      }),
      source({ beatportDoneAt: NOW, trackId: "done" }),
    ]);
    expect(rows.map((row) => [row.trackId, row.nextDueAt])).toEqual([
      ["retry", "2026-08-25T12:00:00.000Z"],
    ]);
  });

  it("splits Deezer finding and catalogue work, preserves their legacy orders, and caps failures", () => {
    const inputs = [
      source({ certified: true, findingAddedAt: "2026-08-01T00:00:00.000Z", trackId: "old" }),
      source({ certified: true, findingAddedAt: "2026-08-02T00:00:00.000Z", trackId: "new" }),
      source({ capturePriority: 1, trackId: "low" }),
      source({ capturePriority: 4, trackId: "high" }),
      source({ deezerFailures: DEEZER_MAX_FAILURES, trackId: "capped" }),
    ];
    expect(queue("deezer-finding", inputs).map((row) => [row.trackId, row.workKind])).toEqual([
      ["new", "deezer-finding"],
      ["old", "deezer-finding"],
    ]);
    expect(queue("deezer-catalogue", inputs).map((row) => [row.trackId, row.workKind])).toEqual([
      ["high", "deezer-catalogue"],
      ["low", "deezer-catalogue"],
    ]);
  });

  it("keeps missing artist-credit and artist-edge definitions distinct", () => {
    const inputs = [
      source({ artistEdgesBackfilledAt: null, hasArtistEdge: false, trackId: "edge" }),
      source({ artistEdgesBackfilledAt: NOW, hasArtistEdge: false, trackId: "credit" }),
      source({ artistEdgesBackfilledAt: NOW, hasArtistEdge: true, trackId: "has-edge" }),
      source({
        artistCreditsBackfilledAt: NOW,
        artistEdgesBackfilledAt: NOW,
        hasArtistEdge: false,
        trackId: "credited",
      }),
    ];
    expect(queue("artist-edges", inputs).map((row) => row.trackId)).toEqual(["edge"]);
    expect(queue("artist-credits", inputs).map((row) => row.trackId)).toEqual(["credit"]);
  });

  it("changes source versions for every declared source column", () => {
    const base = source();
    const baseline = queue("apple-catalogue", [base])[0]?.sourceVersion;
    expect(baseline).toBeDefined();
    for (const column of DUE_WORK_VENDOR_SOURCE_COLUMNS) {
      const value = base[column];
      const changed = Array.isArray(value)
        ? [...value, "changed"]
        : typeof value === "boolean"
          ? !value
          : typeof value === "number"
            ? value + 1
            : value === null
              ? "changed"
              : `${String(value)}-changed`;
      const candidate = { ...base, [column]: changed } as DueWorkVendorSource;
      expect(queue("apple-catalogue", [candidate])[0]?.sourceVersion, column).not.toBe(baseline);
    }
    expect(queue("catalogue-rank", [base], "v5:a")[0]?.sourceVersion).not.toBe(
      queue("catalogue-rank", [base], "v5:b")[0]?.sourceVersion,
    );
  });
});
