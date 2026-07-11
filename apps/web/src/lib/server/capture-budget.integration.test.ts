import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";

// THE LEDGER, PROVEN — against the REAL schema, on a real libSQL engine.
//
// The budget's arithmetic is pure and is proven at the table (capture-budget.test.ts). What
// only a real engine can prove is the SQL the arithmetic is fed:
//
//   1. IT COUNTS THE CATALOGUE, AND ONLY THE CATALOGUE. A finding's capture must be invisible
//      to this budget — it can neither consume it nor be stopped by it.
//   2. IT COUNTS ATTEMPTS, NOT SUCCESSES. A failed download still pulled bytes through the
//      metered proxy. A ledger that only counted successes would let a day of failures spend
//      real money against a meter reading zero.
//   3. THE WINDOW ROLLS. Yesterday's spend is not today's.
//
// No audio is downloaded here (or anywhere in this suite): the capture is simulated by
// writing exactly the columns the sweep writes.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const NOW = Date.parse("2026-07-11T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

/** Simulate what the capture sweep writes on a SUCCESS: the stamp, and the size it landed. */
async function captured(trackId: string, atMs: number, bytes: number): Promise<void> {
  const at = new Date(atMs).toISOString();

  await db.execute({
    args: [at, at, bytes, trackId],
    sql: `update tracks
          set capture_status = 'done', source_audio_key = 'k/x.webm',
              source_audio_attempted_at = ?, source_audio_captured_at = ?, source_audio_bytes = ?
          where track_id = ?`,
  });
}

/** …and what it writes on a FAILURE: the attempt stamp, and no bytes (the pull is unknowable). */
async function attemptFailed(trackId: string, atMs: number): Promise<void> {
  await db.execute({
    args: [new Date(atMs).toISOString(), trackId],
    sql: `update tracks
          set capture_status = 'failed', source_audio_failures = 1, source_audio_attempted_at = ?
          where track_id = ?`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("readCatalogueCaptureSpend — what the catalogue actually spent", () => {
  it("counts every ATTEMPT in the window, and sums only the bytes that LANDED", async () => {
    const { readCatalogueCaptureSpend } = await import("./capture-budget");

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await seedCatalogueTrack(db, { trackId: "cat2000000000000000000" });
    await seedCatalogueTrack(db, { trackId: "cat3000000000000000000" });

    await captured("cat1000000000000000000", NOW - HOUR, 5_000_000);
    await captured("cat2000000000000000000", NOW - 2 * HOUR, 3_000_000);
    // A failure billed a proxy request too — it counts against the COUNT cap. Its partial
    // transfer is genuinely unknowable from the server, so it is under-counted in bytes
    // rather than guessed at. (An honest under-count beats an invented number.)
    await attemptFailed("cat3000000000000000000", NOW - 3 * HOUR);

    expect(await readCatalogueCaptureSpend(NOW)).toEqual({ bytes: 8_000_000, tracks: 3 });
  });

  it("is BLIND to a finding's capture — the archive can never consume the catalogue budget", async () => {
    const { readCatalogueCaptureSpend } = await import("./capture-budget");

    // A certified finding captures ~a handful a week. It is not the spend, it was never the
    // concern, and if it consumed this budget then logging bangers would starve the telescope.
    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await captured("aaaaaaaaaaaaaaaaaaaaaa", NOW - HOUR, 9_000_000);

    expect(await readCatalogueCaptureSpend(NOW)).toEqual({ bytes: 0, tracks: 0 });
  });

  it("rolls: yesterday's spend is not today's", async () => {
    const { readCatalogueCaptureSpend } = await import("./capture-budget");

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await seedCatalogueTrack(db, { trackId: "cat2000000000000000000" });

    await captured("cat1000000000000000000", NOW - 23 * HOUR, 1_000_000); // inside
    await captured("cat2000000000000000000", NOW - 25 * HOUR, 7_000_000); // outside

    // Rolling, not calendar — a midnight reset is a cliff to game (and a cliff to be surprised
    // by at 00:01).
    expect(await readCatalogueCaptureSpend(NOW)).toEqual({ bytes: 1_000_000, tracks: 1 });
  });

  it("reads a legacy capture (no byte meter) as 0 bytes, not as a null that poisons the sum", async () => {
    const { readCatalogueCaptureSpend } = await import("./capture-budget");

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await db.execute({
      args: [new Date(NOW - HOUR).toISOString()],
      sql: `update tracks
            set capture_status = 'done', source_audio_key = 'k/x.webm',
                source_audio_attempted_at = ?, source_audio_bytes = null
            where track_id = 'cat1000000000000000000'`,
    });

    // A row captured before the meter existed. It still counts as an ATTEMPT (it happened);
    // its size is simply not known, and `sum()` over a NULL must not return NULL.
    expect(await readCatalogueCaptureSpend(NOW)).toEqual({ bytes: 0, tracks: 1 });
  });

  it("reads an empty archive as zero spend, not as an error", async () => {
    const { readCatalogueCaptureSpend } = await import("./capture-budget");

    expect(await readCatalogueCaptureSpend(NOW)).toEqual({ bytes: 0, tracks: 0 });
  });
});

describe("getCatalogueCaptureState — what the operator reads, and the queue obeys", () => {
  it("SHIPS PAUSED: an untouched database reads as shut, with the budget intact", async () => {
    const { getCatalogueCaptureState, DEFAULT_DAILY_BYTES, DEFAULT_DAILY_TRACKS } =
      await import("./capture-budget");

    // No `settings` row at all — which is exactly what a fresh deploy, a preview branch, and a
    // restored-from-backup database all look like. Every one of them must read as PAUSED.
    const state = await getCatalogueCaptureState(NOW);

    expect(state.paused).toBe(true);
    expect(state.open).toBe(false);
    expect(state.closedReason).toBe("paused");
    expect(state.budget).toEqual({
      dailyBytes: DEFAULT_DAILY_BYTES,
      dailyTracks: DEFAULT_DAILY_TRACKS,
    });
  });

  it("opens on ONE flip, and shuts again on one flip", async () => {
    const { getCatalogueCaptureState, setCatalogueCapturePaused } =
      await import("./capture-budget");

    await setCatalogueCapturePaused(false);
    expect((await getCatalogueCaptureState(NOW)).open).toBe(true);

    await setCatalogueCapturePaused(true);
    expect((await getCatalogueCaptureState(NOW)).open).toBe(false);
  });

  it("only the literal string `false` runs it — a stray value reads as PAUSED", async () => {
    const { getCatalogueCaptureState } = await import("./capture-budget");
    const { setSetting } = await import("./settings");

    // The default-deny property, tested against the values a bug or a hand-edit could write.
    for (const value of ["true", "", "0", "no", "FALSE", "off", "running", "1"]) {
      await setSetting("catalogue_capture_paused", value);
      expect((await getCatalogueCaptureState(NOW)).paused).toBe(true);
    }

    await setSetting("catalogue_capture_paused", "false");
    expect((await getCatalogueCaptureState(NOW)).paused).toBe(false);
  });

  it("reports the spend against the budget the operator set", async () => {
    const { getCatalogueCaptureState, setCatalogueCaptureBudget, setCatalogueCapturePaused } =
      await import("./capture-budget");

    await setCatalogueCapturePaused(false);
    await setCatalogueCaptureBudget({ dailyBytes: 10_000_000, dailyTracks: 5 });

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await seedCatalogueTrack(db, { trackId: "cat2000000000000000000" });
    await captured("cat1000000000000000000", NOW - HOUR, 4_000_000);
    await captured("cat2000000000000000000", NOW - HOUR, 1_000_000);

    const state = await getCatalogueCaptureState(NOW);

    expect(state.spend).toEqual({ bytes: 5_000_000, tracks: 2 });
    expect(state.remainingTracks).toBe(3);
    expect(state.remainingBytes).toBe(5_000_000);
    expect(state.open).toBe(true);
    expect(state.windowHours).toBe(24);
  });
});
