import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  isCaptureReconciliationEligible,
  isCaptureReconciliationTokenEnvelope,
  sameCaptureReconciliationState,
  type CaptureSnapshot,
} from "./track-capture-reconciliation";

function snapshot(): CaptureSnapshot {
  return {
    extra: {
      bpm: 174,
      captureVerification: null,
      captureVerifiedAt: null,
      enrichmentStatus: "done",
      label: "Hospital Records",
      labelName: "Hospital Records",
      sourceAudioBytes: null,
      sourceAudioCapturedAt: null,
      sourceAudioRejected: null,
      youtubeVerifiedBy: null,
    },
    source: {
      analyzedAt: "2026-09-08T10:00:00.000Z",
      analyzedFrom: "preview",
      artistsJson: '["Netsky"]',
      capturePriority: 2,
      captureStatus: "pending",
      certified: false,
      demandScore: 3,
      dismissedAt: null,
      duplicateOfTrackId: null,
      durationMs: 240_000,
      findingAddedAt: null,
      hasEmbedding: false,
      hasIsrc: true,
      isrc: "GBTEST000000",
      isrcRecoveryAttemptedAt: null,
      labelSeedState: "enabled",
      logId: null,
      nearestFindingScore: 0.8,
      sourceAudioAttemptedAt: null,
      sourceAudioFailures: 0,
      sourceAudioKey: null,
      sourceVerification: null,
      spotifyAnchorAttemptedAt: null,
      spotifyAnchorAttempts: null,
      spotifyUri: null,
      title: "Come Alive",
      trackId: "track-1",
      youtubeProvenanceFailures: 0,
      youtubeVerifiedAt: null,
      youtubeVideoId: null,
      youtubeVideoOfficial: null,
    },
    sourceVersion: "dw1-fixture",
  };
}

describe("capture reconciliation expected state", () => {
  test("allows order-only demand and rank churn during a long provider operation", () => {
    const prepared = snapshot();
    const current = structuredClone(prepared);
    current.source.demandScore = 99;
    current.source.nearestFindingScore = 0.9;
    current.source.capturePriority = 8;
    current.sourceVersion = "dw1-routine-rank-refresh";

    expect(sameCaptureReconciliationState(prepared, current, "capture")).toBe(true);
    expect(isCaptureReconciliationEligible(current, "capture", new Date())).toBe(true);
  });

  test("rejects a newer wrong-audio ruling and larger rejection memory", () => {
    const prepared = snapshot();
    const current = structuredClone(prepared);
    current.source.captureStatus = "wrong-audio";
    current.extra.sourceAudioRejected = '[{"sha256":"newer"}]';

    expect(sameCaptureReconciliationState(prepared, current, "capture")).toBe(false);
  });

  test("rejects a newly excluded capture priority", () => {
    const prepared = snapshot();
    const current = structuredClone(prepared);
    current.source.capturePriority = -1;

    expect(sameCaptureReconciliationState(prepared, current, "capture")).toBe(true);
    expect(isCaptureReconciliationEligible(current, "capture", new Date())).toBe(false);
  });

  test("rejects provenance that another writer already settled", () => {
    const prepared = snapshot();
    prepared.source.sourceAudioKey = "catalogue/track-1/audio.opus";
    prepared.source.captureStatus = "done";
    const current = structuredClone(prepared);
    current.source.sourceVerification = "soundcloud-archive-match";

    expect(sameCaptureReconciliationState(prepared, current, "youtube-provenance")).toBe(false);
  });
});

describe("capture reconciliation transaction and provider boundaries", () => {
  const source = readFileSync(
    new URL("./track-capture-reconciliation.ts", import.meta.url),
    "utf8",
  );
  const authorize = source.slice(
    source.indexOf("export async function authorizeCaptureReconciliation"),
    source.indexOf("function relevantSnapshot("),
  );
  const commit = source.slice(source.indexOf("export async function commitCaptureReconciliation"));

  test("server-owned oEmbed officialness performs no database I/O", () => {
    expect(authorize).toContain("await checkYoutubeOfficial(");
    expect(authorize).not.toContain("getDb(");
    expect(authorize).not.toContain("readCaptureSnapshot(");
  });

  test("re-reads expected state and commits every side-effect marker with the terminal receipt", () => {
    expect(commit).toContain("executeReceiptBackedOperation({");
    expect(commit).toContain("effect: async (transaction) => {");
    expect(commit.indexOf("readCaptureSnapshot(transaction")).toBeLessThan(
      commit.indexOf("applyCaptureResult(transaction"),
    );
    expect(commit).toContain("sameCaptureReconciliationState(current, token.snapshot, token.kind)");
    expect(commit).toContain("isCaptureReconciliationEligible(current, token.kind, new Date())");

    const application = source.slice(
      source.indexOf("async function applyCaptureResult("),
      source.indexOf("export async function commitCaptureReconciliation"),
    );
    expect(application).toContain("source_audio_failures = coalesce(source_audio_failures, 0) + 1");
    expect(application).toContain(
      "youtube_provenance_failures = coalesce(youtube_provenance_failures, 0) + 1",
    );
    expect(application).toContain("await transaction.batch(statements)");
  });

  test("rejects oversized, future-issued, or overlong signed token envelopes", () => {
    expect(source).toContain("token.length > TOKEN_MAX_LENGTH");
    expect(source).toContain("(iat as number) > Date.now() + TOKEN_CLOCK_SKEW_MS");
    expect(source).toContain("(expiresAt as number) - (iat as number) > TOKEN_MAX_AGE_MS");
  });

  test("accepts the stored 0/1 officialness verdict rather than a boolean lookalike", () => {
    const iat = Date.now();
    const envelope = {
      expiresAt: iat + 1_000,
      iat,
      kind: "capture",
      official: 0,
      result: {
        attemptedAt: new Date(iat).toISOString(),
        kind: "capture",
        outcome: "unmatched",
      },
      snapshot: snapshot(),
      stage: "commit",
      trackId: "track-1",
    };

    expect(isCaptureReconciliationTokenEnvelope(envelope, "commit")).toBe(true);
    expect(isCaptureReconciliationTokenEnvelope({ ...envelope, official: false }, "commit")).toBe(
      false,
    );
  });
});
