import { describe, expect, it } from "vitest";

import {
  ANCHOR_MAX_ATTEMPTS,
  CAPTURE_MAX_FAILURES,
  DUE_WORK_TRACK_PAYLOAD_ONLY_SOURCE_COLUMNS,
  DUE_WORK_TRACK_SOURCE_COLUMNS,
  LONG_FORM_MS,
  MIN_TRACK_MS,
  YOUTUBE_PROVENANCE_MAX_FAILURES,
  dueWorkTrackSourceVersion,
  evaluateDueWorkQueue,
  type DueWorkTrackSource,
} from "./due-work-track-definitions";

const NOW = "2026-08-26T12:00:00.000Z";

function source(overrides: Partial<DueWorkTrackSource> = {}): DueWorkTrackSource {
  return {
    analyzedAt: null,
    analyzedFrom: null,
    artistsJson: '["Calibre"]',
    capturePriority: 1,
    captureStatus: null,
    certified: false,
    demandScore: null,
    dismissedAt: null,
    duplicateOfTrackId: null,
    durationMs: 180_000,
    findingAddedAt: null,
    hasEmbedding: false,
    hasIsrc: false,
    isrc: null,
    isrcRecoveryAttemptedAt: null,
    labelSeedState: null,
    logId: null,
    nearestFindingScore: null,
    sourceAudioAttemptedAt: null,
    sourceAudioFailures: 0,
    sourceAudioKey: null,
    sourceVerification: null,
    spotifyAnchorAttemptedAt: null,
    spotifyAnchorAttempts: 0,
    spotifyUri: null,
    title: "Even If",
    trackId: "track-a",
    youtubeProvenanceFailures: 0,
    youtubeVerifiedAt: null,
    youtubeVideoId: null,
    youtubeVideoOfficial: null,
    ...overrides,
  };
}

function queue(
  kind: Parameters<typeof evaluateDueWorkQueue>[0]["kind"],
  sources: DueWorkTrackSource[],
) {
  return evaluateDueWorkQueue({ kind, now: NOW, sources });
}

describe("due-work track definitions", () => {
  it("keeps the source type and explicit inventory in lockstep", () => {
    expect(
      [...DUE_WORK_TRACK_SOURCE_COLUMNS, ...DUE_WORK_TRACK_PAYLOAD_ONLY_SOURCE_COLUMNS].sort(),
    ).toEqual(Object.keys(source()).sort());
  });

  it("splits certified and catalogue capture work and applies catalogue-only vetoes", () => {
    const rows = queue("capture", [
      source({ certified: true, logId: "F-01", trackId: "finding" }),
      source({ trackId: "catalogue" }),
      source({ capturePriority: null, trackId: "unranked" }),
      source({ capturePriority: -1, trackId: "vetoed" }),
      source({ dismissedAt: NOW, trackId: "dismissed" }),
      source({ durationMs: MIN_TRACK_MS - 1, trackId: "short" }),
      source({ durationMs: LONG_FORM_MS, trackId: "mix" }),
      source({
        certified: true,
        durationMs: LONG_FORM_MS,
        logId: null,
        trackId: "coordinate-less",
      }),
    ]);
    expect(rows.map((row) => [row.trackId, row.workKind])).toEqual([
      ["finding", "capture-findings"],
      ["catalogue", "capture-catalogue"],
    ]);
  });

  it("schedules capture retries for one hour and drops capped failures", () => {
    const attempted = "2026-08-26T11:30:00.000Z";
    const rows = queue("capture", [
      source({ captureStatus: "failed", sourceAudioAttemptedAt: attempted, trackId: "failed" }),
      source({
        captureStatus: "duplicate-cleared",
        sourceAudioAttemptedAt: attempted,
        trackId: "forced",
      }),
      source({ captureStatus: "duplicate-cleared", sourceAudioKey: "audio", trackId: "captured" }),
      source({
        captureStatus: "failed",
        sourceAudioFailures: CAPTURE_MAX_FAILURES,
        trackId: "capped",
      }),
      source({
        captureStatus: "wrong-audio",
        sourceAudioFailures: CAPTURE_MAX_FAILURES,
        trackId: "wrong",
      }),
    ]);
    expect(rows.map((row) => [row.trackId, row.nextDueAt])).toEqual([
      ["wrong", NOW],
      ["forced", "2026-08-26T12:30:00.001Z"],
      ["failed", "2026-08-26T12:30:00.001Z"],
    ]);
  });

  it("requires full-audio re-analysis while embedding mirrors the captured-audio predicate", () => {
    const rows = [
      source({
        analyzedAt: NOW,
        analyzedFrom: "full",
        captureStatus: "done",
        sourceAudioKey: "audio",
        trackId: "full",
      }),
      source({
        analyzedAt: NOW,
        analyzedFrom: "preview",
        captureStatus: "done",
        sourceAudioKey: "audio",
        trackId: "preview",
      }),
      source({
        analyzedAt: NOW,
        analyzedFrom: null,
        captureStatus: "done",
        sourceAudioKey: "audio",
        trackId: "unknown",
      }),
      source({ sourceAudioKey: null, trackId: "missing" }),
      source({ captureStatus: "wrong-audio", sourceAudioKey: "audio", trackId: "bad" }),
    ];
    expect(queue("analyze", rows).map((row) => row.trackId)).toEqual(["unknown", "preview"]);
    expect(queue("embed", rows).map((row) => row.trackId)).toEqual(["unknown", "preview", "full"]);
    expect(
      queue("embed", [
        source({ captureStatus: "done", hasEmbedding: true, sourceAudioKey: "audio" }),
      ]),
    ).toEqual([]);
  });

  it("schedules provenance at ninety days, caps failures, and only reverdicts non-official ids", () => {
    const rows = queue("youtube-provenance", [
      source({
        sourceAudioKey: "audio",
        trackId: "future",
        youtubeVerifiedAt: "2026-08-01T12:00:00.000Z",
      }),
      source({
        sourceAudioKey: "audio",
        trackId: "ready",
        youtubeVerifiedAt: "2026-05-01T12:00:00.000Z",
      }),
      source({
        sourceAudioKey: "audio",
        trackId: "capped",
        youtubeProvenanceFailures: YOUTUBE_PROVENANCE_MAX_FAILURES,
      }),
      source({ sourceAudioKey: "audio", sourceVerification: "fingerprint", trackId: "verified" }),
    ]);
    expect(rows.map((row) => [row.trackId, row.nextDueAt])).toEqual([
      ["ready", "2026-07-30T12:00:00.001Z"],
      ["future", "2026-10-30T12:00:00.001Z"],
    ]);
    expect(
      queue("youtube-reverdict", [
        source({ trackId: "never", youtubeVideoId: "a", youtubeVideoOfficial: null }),
        source({
          trackId: "no",
          youtubeVerifiedAt: "2026-01-01T00:00:00.000Z",
          youtubeVideoId: "b",
          youtubeVideoOfficial: false,
        }),
        source({ trackId: "yes", youtubeVideoId: "c", youtubeVideoOfficial: true }),
      ]).map((row) => row.trackId),
    ).toEqual(["never", "no"]);
  });

  it("globally orders re-verdict work across certification halves", () => {
    expect(
      queue("youtube-reverdict", [
        source({
          certified: true,
          findingAddedAt: "2026-08-01T00:00:00.000Z",
          logId: "F-01",
          trackId: "finding-newer-verdict",
          youtubeVerifiedAt: "2026-08-01T00:00:00.000Z",
          youtubeVideoId: "finding-video",
          youtubeVideoOfficial: false,
        }),
        source({
          trackId: "catalogue-older-verdict",
          youtubeVerifiedAt: "2026-01-01T00:00:00.000Z",
          youtubeVideoId: "catalogue-video",
          youtubeVideoOfficial: false,
        }),
      ]).map((row) => row.trackId),
    ).toEqual(["catalogue-older-verdict", "finding-newer-verdict"]);
  });

  it("applies anchor and recovery backoffs, caps, placeholder credits, and disabled labels", () => {
    const rows = queue("anchor", [
      source({ spotifyAnchorAttemptedAt: "2026-08-20T12:00:00.000Z", trackId: "future" }),
      source({ spotifyAnchorAttemptedAt: "2026-08-01T12:00:00.000Z", trackId: "ready" }),
      source({ spotifyAnchorAttempts: ANCHOR_MAX_ATTEMPTS, trackId: "cap" }),
      source({ artistsJson: '["Unknown Artist"]', trackId: "placeholder" }),
      source({ labelSeedState: "disabled", trackId: "disabled" }),
      source({ dismissedAt: NOW, trackId: "dismissed" }),
      source({ duplicateOfTrackId: "finding", trackId: "duplicate" }),
    ]);
    expect(rows.map((row) => [row.trackId, row.nextDueAt])).toEqual([
      ["ready", "2026-08-15T12:00:00.001Z"],
      ["future", "2026-09-03T12:00:00.001Z"],
    ]);
    expect(
      queue("isrc-recovery", [
        source({ isrcRecoveryAttemptedAt: "2026-08-20T12:00:00.000Z", trackId: "future" }),
        source({ isrcRecoveryAttemptedAt: "2026-07-01T12:00:00.000Z", trackId: "ready" }),
        source({ spotifyAnchorAttemptedAt: NOW, trackId: "anchored" }),
        source({ hasIsrc: true, trackId: "has-isrc" }),
      ]).map((row) => [row.trackId, row.nextDueAt]),
    ).toEqual([
      ["ready", "2026-07-22T12:00:00.001Z"],
      ["future", "2026-09-10T12:00:00.001Z"],
    ]);
  });

  it("preserves shared, specialist, and re-verdict legacy sort orders", () => {
    expect(
      queue("capture", [
        source({ capturePriority: 1, demandScore: 9, trackId: "low" }),
        source({ capturePriority: 2, demandScore: 0, trackId: "high" }),
        source({ capturePriority: 1, demandScore: 10, trackId: "demand" }),
      ]).map((row) => row.trackId),
    ).toEqual(["high", "demand", "low"]);
    expect(
      queue("anchor", [
        source({ hasEmbedding: false, hasIsrc: true, nearestFindingScore: 0.8, trackId: "score" }),
        source({
          hasEmbedding: true,
          hasIsrc: true,
          nearestFindingScore: 0.1,
          trackId: "embedded",
        }),
        source({ hasEmbedding: true, hasIsrc: false, nearestFindingScore: 1, trackId: "tail" }),
      ]).map((row) => row.trackId),
    ).toEqual(["embedded", "score", "tail"]);
    expect(
      queue("youtube-reverdict", [
        source({
          trackId: "old",
          youtubeVerifiedAt: "2020-01-01T00:00:00.000Z",
          youtubeVideoId: "old",
          youtubeVideoOfficial: false,
        }),
        source({ trackId: "never", youtubeVideoId: "never", youtubeVideoOfficial: false }),
      ]).map((row) => row.trackId),
    ).toEqual(["never", "old"]);
  });

  it("changes the source version for every declared source column", () => {
    const base = source({ captureStatus: "pending", sourceAudioKey: "audio" });
    const baseline = dueWorkTrackSourceVersion(base);
    for (const column of [
      ...DUE_WORK_TRACK_SOURCE_COLUMNS,
      ...DUE_WORK_TRACK_PAYLOAD_ONLY_SOURCE_COLUMNS,
    ]) {
      const value = base[column];
      const changed =
        typeof value === "boolean"
          ? !value
          : typeof value === "number"
            ? value + 1
            : value === null
              ? "changed"
              : `${value}-changed`;
      const candidate = { ...base, [column]: changed } as DueWorkTrackSource;
      expect(dueWorkTrackSourceVersion(candidate), column).not.toBe(baseline);
    }
  });
});
