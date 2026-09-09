import { type Client } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationDb, seedTrack } from "./integration-db";

let db: Client;
let databaseDirectory: string;
const checkYoutubeOfficial = vi.fn();

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./env")>();
  return {
    ...actual,
    readEnv: (name: Parameters<typeof actual.readEnv>[0]) =>
      name === "ADMIN_SESSION_SECRET"
        ? Promise.resolve("capture-test-secret")
        : actual.readEnv(name),
  };
});

vi.mock("./youtube-official", () => ({
  checkYoutubeOfficial: (...args: unknown[]) => checkYoutubeOfficial(...args),
}));

const TRACK_ID = "capture-reconciliation-track";
const LOG_ID = "099.9.9Z";

beforeEach(async () => {
  databaseDirectory = await mkdtemp(join(tmpdir(), "capture-reconciliation-test-"));
  db = await createIntegrationDb({ url: `file:${join(databaseDirectory, "test.sqlite")}` });
  await seedTrack(db, { logId: LOG_ID, trackId: TRACK_ID });
  checkYoutubeOfficial.mockReset().mockResolvedValue(1);
});

afterEach(async () => {
  db.close();
  await rm(databaseDirectory, { force: true, recursive: true });
});

describe("capture reconciliation against the real schema", () => {
  it("replays an unknown commit response without incrementing a failure twice", async () => {
    const {
      authorizeCaptureReconciliation,
      commitCaptureReconciliation,
      prepareCaptureReconciliation,
    } = await import("./track-capture-reconciliation");
    const prepared = await prepareCaptureReconciliation(TRACK_ID, "capture");
    expect(prepared.prepared).toBe(true);
    if (!prepared.prepared) {
      return;
    }
    const receipt = await authorizeCaptureReconciliation({
      result: {
        attemptedAt: "2026-09-08T10:00:00.000Z",
        kind: "capture",
        outcome: "failed",
      },
      snapshotToken: prepared.snapshotToken,
      trackId: TRACK_ID,
    });

    const first = await commitCaptureReconciliation({ ...receipt, trackId: TRACK_ID });
    const replay = await commitCaptureReconciliation({ ...receipt, trackId: TRACK_ID });

    expect(first).toMatchObject({ outcome: "committed", replayed: false });
    expect(replay).toMatchObject({ outcome: "committed", replayed: true });
    const state = await db.execute({
      args: [TRACK_ID],
      sql: `select capture_status, source_audio_attempted_at, source_audio_failures
            from tracks where track_id = ?`,
    });
    expect(state.rows[0]).toMatchObject({
      capture_status: "failed",
      source_audio_attempted_at: "2026-09-08T10:00:00.000Z",
      source_audio_failures: 1,
    });
    const receipts = await db.execute("select count(*) as count from operation_receipts");
    expect(Number(receipts.rows[0]?.count)).toBe(1);
  });

  it("atomically refuses an older result after wrong-audio and rejection memory advance", async () => {
    const {
      authorizeCaptureReconciliation,
      commitCaptureReconciliation,
      prepareCaptureReconciliation,
    } = await import("./track-capture-reconciliation");
    const prepared = await prepareCaptureReconciliation(TRACK_ID, "capture");
    expect(prepared.prepared).toBe(true);
    if (!prepared.prepared) {
      return;
    }
    const receipt = await authorizeCaptureReconciliation({
      result: {
        attemptedAt: "2026-09-08T10:00:00.000Z",
        kind: "capture",
        outcome: "failed",
      },
      snapshotToken: prepared.snapshotToken,
      trackId: TRACK_ID,
    });
    const rejection = '[{"sha256":"newer"}]';
    await db.execute({
      args: [rejection, TRACK_ID],
      sql: `update tracks set capture_status = 'wrong-audio', source_audio_rejected = ?
            where track_id = ?`,
    });

    const outcome = await commitCaptureReconciliation({ ...receipt, trackId: TRACK_ID });

    expect(outcome).toMatchObject({ outcome: "rejected", replayed: false });
    const state = await db.execute({
      args: [TRACK_ID],
      sql: `select capture_status, source_audio_rejected, source_audio_failures
            from tracks where track_id = ?`,
    });
    expect(state.rows[0]).toMatchObject({
      capture_status: "wrong-audio",
      source_audio_failures: 0,
      source_audio_rejected: rejection,
    });
  });

  it("accepts routine rank churn while preserving the prepared capture decision", async () => {
    const {
      authorizeCaptureReconciliation,
      commitCaptureReconciliation,
      prepareCaptureReconciliation,
    } = await import("./track-capture-reconciliation");
    const prepared = await prepareCaptureReconciliation(TRACK_ID, "capture");
    expect(prepared.prepared).toBe(true);
    if (!prepared.prepared) {
      return;
    }
    const receipt = await authorizeCaptureReconciliation({
      result: {
        attemptedAt: "2026-09-08T10:00:00.000Z",
        kind: "capture",
        outcome: "unmatched",
      },
      snapshotToken: prepared.snapshotToken,
      trackId: TRACK_ID,
    });
    await db.execute({
      args: [TRACK_ID],
      sql: `update tracks
            set capture_priority = 8, demand_score = 99, nearest_finding_score = 0.95
            where track_id = ?`,
    });

    const outcome = await commitCaptureReconciliation({ ...receipt, trackId: TRACK_ID });

    expect(outcome).toMatchObject({ outcome: "committed", replayed: false });
    const state = await db.execute({
      args: [TRACK_ID],
      sql: "select capture_status from tracks where track_id = ?",
    });
    expect(state.rows[0]?.capture_status).toBe("unmatched");
  });

  it("refuses provider work when a fresh provenance prepare sees newer eligibility", async () => {
    const { prepareCaptureReconciliation } = await import("./track-capture-reconciliation");
    await db.execute({
      args: [TRACK_ID],
      sql: `update tracks
            set capture_status = 'done', source_audio_key = '099.9.9Z/archive.opus'
            where track_id = ?`,
    });
    const initiallyEligible = await prepareCaptureReconciliation(TRACK_ID, "youtube-provenance");
    expect(initiallyEligible.prepared).toBe(true);
    await db.execute({
      args: [TRACK_ID],
      sql: `update tracks set source_verification = 'soundcloud-archive-match'
            where track_id = ?`,
    });

    const current = await prepareCaptureReconciliation(TRACK_ID, "youtube-provenance");

    expect(current).toEqual({ prepared: false, reason: "ineligible" });
    expect(checkYoutubeOfficial).not.toHaveBeenCalled();
  });

  it("refuses a YouTube id that the box did not fingerprint", async () => {
    const { authorizeCaptureReconciliation, prepareCaptureReconciliation } =
      await import("./track-capture-reconciliation");
    const prepared = await prepareCaptureReconciliation(TRACK_ID, "capture");
    expect(prepared.prepared).toBe(true);
    if (!prepared.prepared) {
      return;
    }
    const at = "2026-09-08T10:00:00.000Z";

    await expect(
      authorizeCaptureReconciliation({
        result: {
          attemptedAt: at,
          bytes: 123,
          captureVerification: "unverified",
          capturedAt: at,
          kind: "capture",
          outcome: "done",
          sourceAudioKey: `${LOG_ID}/${"a".repeat(64)}.opus`,
          verifiedAt: at,
          youtubeVideoId: "box-asserted-id",
        },
        snapshotToken: prepared.snapshotToken,
        trackId: TRACK_ID,
      }),
    ).rejects.toMatchObject({ code: "invalid_capture_result", status: 422 });
    expect(checkYoutubeOfficial).not.toHaveBeenCalled();
  });

  it("banks accepted audio without clobbering a newer in-progress enrichment", async () => {
    const {
      authorizeCaptureReconciliation,
      commitCaptureReconciliation,
      prepareCaptureReconciliation,
    } = await import("./track-capture-reconciliation");
    const prepared = await prepareCaptureReconciliation(TRACK_ID, "capture");
    expect(prepared.prepared).toBe(true);
    if (!prepared.prepared) {
      return;
    }
    const at = "2026-09-08T10:00:00.000Z";
    const receipt = await authorizeCaptureReconciliation({
      result: {
        attemptedAt: at,
        bytes: 123,
        captureVerification: "unverified",
        capturedAt: at,
        kind: "capture",
        outcome: "done",
        sourceAudioKey: `${LOG_ID}/${"a".repeat(64)}.opus`,
        verifiedAt: at,
      },
      snapshotToken: prepared.snapshotToken,
      trackId: TRACK_ID,
    });
    await db.execute({
      args: [TRACK_ID],
      sql: "update findings set enrichment_status = 'processing' where track_id = ?",
    });

    const outcome = await commitCaptureReconciliation({ ...receipt, trackId: TRACK_ID });

    expect(outcome).toMatchObject({ outcome: "committed", replayed: false });
    const state = await db.execute({
      args: [TRACK_ID],
      sql: `select t.capture_status, f.enrichment_status
            from tracks t join findings f on f.track_id = t.track_id
            where t.track_id = ?`,
    });
    expect(state.rows[0]).toMatchObject({
      capture_status: "done",
      enrichment_status: "processing",
    });
  });
});
