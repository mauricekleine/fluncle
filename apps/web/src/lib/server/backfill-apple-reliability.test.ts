import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";

import { backfillAppleReliability } from "../../../scripts/backfill-apple-reliability";
import { createIntegrationDb, seedTrack } from "./integration-db";

// THE APPLE RELIABILITY CARRY, PROVEN against the REAL schema (RFC musickit U1). The Apple sweep's
// bookkeeping moved from `findings` to `tracks`; this one-time, gated step copies existing findings'
// state across so the moved sweep resumes instead of re-hitting every already-resolved ISRC.

let db: Client;

/** Stamp a finding's OLD apple reliability state on the `findings` row (the carry's source). */
async function withFindingAppleState(
  trackId: string,
  state: { attempts: number; attemptedAt: string; doneAt: null | string; failures: number },
): Promise<void> {
  await db.execute({
    args: [state.attemptedAt, state.attempts, state.doneAt, state.failures, trackId],
    sql: `update findings
          set backfill_apple_music_attempted_at = ?,
              backfill_apple_music_attempts = ?,
              backfill_apple_music_done_at = ?,
              backfill_apple_music_failures = ?
          where track_id = ?`,
  });
}

async function readTrackApple(trackId: string): Promise<Record<string, unknown> | undefined> {
  const result = await db.execute({
    args: [trackId],
    sql: `select backfill_apple_music_attempted_at as attempted_at,
                 backfill_apple_music_attempts as attempts,
                 backfill_apple_music_done_at as done_at,
                 backfill_apple_music_failures as failures
          from tracks where track_id = ?`,
  });

  return result.rows[0] as Record<string, unknown> | undefined;
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("backfillAppleReliability — the one-time carry", () => {
  it("carries a finding's Apple state onto its tracks row and stamps the marker", async () => {
    await seedTrack(db, { logId: "LOG-1", trackId: "track00000000000000001" });
    await withFindingAppleState("track00000000000000001", {
      attemptedAt: "2026-06-01T00:00:00.000Z",
      attempts: 2,
      doneAt: "2026-06-01T00:00:05.000Z",
      failures: 0,
    });

    const result = await backfillAppleReliability(db);

    expect(result).toEqual({ carried: true, copied: 1 });
    const track = await readTrackApple("track00000000000000001");
    expect(track?.attempted_at).toBe("2026-06-01T00:00:00.000Z");
    expect(Number(track?.attempts)).toBe(2);
    expect(track?.done_at).toBe("2026-06-01T00:00:05.000Z");

    // The marker is stamped, so a second run is a gated no-op.
    const marker = await db.execute({
      sql: `select value from settings where key = 'apple_reliability_carried_at'`,
    });
    expect(marker.rows).toHaveLength(1);
  });

  it("is gated — a second run copies nothing (findings is now frozen)", async () => {
    await seedTrack(db, { logId: "LOG-1", trackId: "track00000000000000001" });
    await withFindingAppleState("track00000000000000001", {
      attemptedAt: "2026-06-01T00:00:00.000Z",
      attempts: 1,
      doneAt: null,
      failures: 3,
    });

    await backfillAppleReliability(db);
    const second = await backfillAppleReliability(db);

    expect(second).toEqual({ carried: false, copied: 0 });
  });

  it("copies ONLY findings that carry Apple state (attempted_at set)", async () => {
    // One finding with state, one without — only the first is carried.
    await seedTrack(db, { logId: "LOG-1", trackId: "track00000000000000001" });
    await seedTrack(db, { logId: "LOG-2", trackId: "track00000000000000002" });
    await withFindingAppleState("track00000000000000001", {
      attemptedAt: "2026-06-01T00:00:00.000Z",
      attempts: 1,
      doneAt: null,
      failures: 0,
    });

    const result = await backfillAppleReliability(db);

    expect(result.copied).toBe(1);
    expect((await readTrackApple("track00000000000000002"))?.attempted_at).toBeNull();
  });

  it("never clobbers tracks state the moved sweep already wrote", async () => {
    await seedTrack(db, { logId: "LOG-1", trackId: "track00000000000000001" });
    await withFindingAppleState("track00000000000000001", {
      attemptedAt: "2026-06-01T00:00:00.000Z",
      attempts: 1,
      doneAt: null,
      failures: 0,
    });
    // The moved sweep already stamped a fresher value on `tracks`.
    await db.execute({
      args: ["2026-07-10T00:00:00.000Z", "track00000000000000001"],
      sql: `update tracks set backfill_apple_music_attempted_at = ? where track_id = ?`,
    });

    const result = await backfillAppleReliability(db);

    expect(result.copied).toBe(0);
    expect((await readTrackApple("track00000000000000001"))?.attempted_at).toBe(
      "2026-07-10T00:00:00.000Z",
    );
  });
});
