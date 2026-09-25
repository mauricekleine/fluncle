import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const NOW = Date.parse("2026-07-11T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

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

    await attemptFailed("cat3000000000000000000", NOW - 3 * HOUR);

    expect(await readCatalogueCaptureSpend(NOW)).toEqual({ bytes: 8_000_000, tracks: 3 });
  });

  it("is BLIND to a finding's capture — the archive can never consume the catalogue budget", async () => {
    const { readCatalogueCaptureSpend } = await import("./capture-budget");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await captured("aaaaaaaaaaaaaaaaaaaaaa", NOW - HOUR, 9_000_000);

    expect(await readCatalogueCaptureSpend(NOW)).toEqual({ bytes: 0, tracks: 0 });
  });

  it("rolls: yesterday's spend is not today's", async () => {
    const { readCatalogueCaptureSpend } = await import("./capture-budget");

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await seedCatalogueTrack(db, { trackId: "cat2000000000000000000" });

    await captured("cat1000000000000000000", NOW - 23 * HOUR, 1_000_000);
    await captured("cat2000000000000000000", NOW - 25 * HOUR, 7_000_000);

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

describe("isCatalogueCaptureOpen — the brake asks the cheap question first", () => {
  const spendStatements = (calls: readonly unknown[][]): unknown[][] =>
    calls.filter((call) => JSON.stringify(call[0] ?? "").includes("source_audio_attempted_at"));

  it("reads NO spend while paused — the verdict is already decided", async () => {
    const { isCatalogueCaptureOpen } = await import("./capture-budget");

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await captured("cat1000000000000000000", NOW - HOUR, 4_000_000);

    const spy = vi.spyOn(db, "execute");

    expect(await isCatalogueCaptureOpen(NOW)).toBe(false);
    expect(spendStatements(spy.mock.calls)).toEqual([]);

    spy.mockRestore();
  });

  it("reads the spend once it is un-paused, and agrees with the readout", async () => {
    const {
      getCatalogueCaptureState,
      isCatalogueCaptureOpen,
      setCatalogueCaptureBudget,
      setCatalogueCapturePaused,
    } = await import("./capture-budget");

    await setCatalogueCapturePaused(false);
    await setCatalogueCaptureBudget({ dailyBytes: 10_000_000, dailyTracks: 1 });

    const spy = vi.spyOn(db, "execute");

    expect(await isCatalogueCaptureOpen(NOW)).toBe(true);
    expect(spendStatements(spy.mock.calls).length).toBe(1);

    spy.mockRestore();

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await captured("cat1000000000000000000", NOW - HOUR, 1_000_000);

    expect(await isCatalogueCaptureOpen(NOW)).toBe(false);
    expect((await getCatalogueCaptureState(NOW)).closedReason).toBe("tracks_spent");
  });

  it("the batch admission reads NO spend while paused, and agrees with the readout once open", async () => {
    const {
      getCatalogueCaptureState,
      readCatalogueCaptureAdmission,
      setCatalogueCaptureBudget,
      setCatalogueCapturePaused,
    } = await import("./capture-budget");

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await captured("cat1000000000000000000", NOW - HOUR, 1_000_000);

    const paused = vi.spyOn(db, "execute");

    expect(await readCatalogueCaptureAdmission(NOW)).toEqual({ open: false, remainingTracks: 0 });
    expect(spendStatements(paused.mock.calls)).toEqual([]);

    paused.mockRestore();

    await setCatalogueCapturePaused(false);
    await setCatalogueCaptureBudget({ dailyBytes: 10_000_000, dailyTracks: 3 });

    const open = vi.spyOn(db, "execute");
    const admission = await readCatalogueCaptureAdmission(NOW);

    expect(spendStatements(open.mock.calls).length).toBe(1);

    open.mockRestore();

    const readout = await getCatalogueCaptureState(NOW);

    expect(admission).toEqual({ open: true, remainingTracks: 2 });
    expect(admission).toEqual({ open: readout.open, remainingTracks: readout.remainingTracks });
  });
});
