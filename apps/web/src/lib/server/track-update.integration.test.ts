import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedTrack } from "./integration-db";

// `fillEmptyNote` is the AGENT-tier, race-safe note write: the fill-empty-only guard
// is a DB predicate (`and (note is null or trim(note) = '')`), not a check-then-act
// in JS. These cases run against the REAL in-memory libSQL schema so the predicate's
// actual SQL semantics are proven — a mock could not prove SQLite's `trim()` matches
// whitespace, nor that a populated `note` row is genuinely protected from a clobber.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return {
    ...actual,
    getDb: () => Promise.resolve(db),
  };
});

const TRACK_ID = "abcdefghij0123456789AB"; // 22 chars, the tracks PK shape

async function noteOf(trackId: string): Promise<null | string> {
  const result = await db.execute({
    args: [trackId],
    sql: "select note from findings where track_id = ?",
  });

  return (result.rows[0]?.note as null | string) ?? null;
}

async function setNote(trackId: string, note: null | string): Promise<void> {
  await db.execute({
    args: [note, trackId],
    sql: "update findings set note = ? where track_id = ?",
  });
}

describe("fillEmptyNote — the atomic fill-empty-only guard", () => {
  beforeEach(async () => {
    db = await createIntegrationDb();
    await seedTrack(db, { logId: "004.7.2I", trackId: TRACK_ID });
  });

  it("fills an EMPTY (null) note — returns true and stores it", async () => {
    const { fillEmptyNote } = await import("./track-update");

    const filled = await fillEmptyNote(TRACK_ID, "Pure rolling menace, patient and mean.");

    expect(filled).toBe(true);
    expect(await noteOf(TRACK_ID)).toBe("Pure rolling menace, patient and mean.");
  });

  it("fills a WHITESPACE-ONLY (spaces) note — trim() counts it as empty (returns true, stores)", async () => {
    // SQLite's default `trim()` strips ASCII spaces, so a spaces-only note reads as
    // empty and is filled — mirroring the fast-path JS `note?.trim()` guard for the
    // common case. A real note (operator or agent) is always non-whitespace prose.
    const { fillEmptyNote } = await import("./track-update");
    await setNote(TRACK_ID, "     ");

    const filled = await fillEmptyNote(TRACK_ID, "A late roller that would not let go.");

    expect(filled).toBe(true);
    expect(await noteOf(TRACK_ID)).toBe("A late roller that would not let go.");
  });

  it("does NOT clobber an EXISTING note — returns false, the stored note is unchanged", async () => {
    const { fillEmptyNote } = await import("./track-update");
    // Simulate the interleave: an operator note lands (via the update_track path)
    // after the handler's read would have passed but before this write.
    await setNote(TRACK_ID, "An operator's hand-set note that must win.");

    const filled = await fillEmptyNote(TRACK_ID, "The agent's note that must lose the race.");

    expect(filled).toBe(false);
    // The predicate matched no row — the operator's note is intact, never overwritten.
    expect(await noteOf(TRACK_ID)).toBe("An operator's hand-set note that must win.");
  });

  it("bumps updated_at when it fills, and NOT when it loses the race", async () => {
    const { fillEmptyNote } = await import("./track-update");
    // Anchor a known-old updated_at so a real bump is observable.
    const OLD = "2000-01-01T00:00:00.000Z";
    await db.execute({
      args: [OLD, TRACK_ID],
      sql: "update findings set updated_at = ? where track_id = ?",
    });

    // Fill an empty note → the write bumps updated_at (note is a VISIBLE field).
    const filled = await fillEmptyNote(TRACK_ID, "First light, and the drop just holds.");
    expect(filled).toBe(true);

    const afterFill = await db.execute({
      args: [TRACK_ID],
      sql: "select updated_at from findings where track_id = ?",
    });
    const bumped = afterFill.rows[0]?.updated_at as string;
    expect(bumped).not.toBe(OLD);

    // Re-anchor, then a losing fill (note now present) must NOT touch updated_at.
    await db.execute({
      args: [OLD, TRACK_ID],
      sql: "update findings set updated_at = ? where track_id = ?",
    });
    const lost = await fillEmptyNote(TRACK_ID, "A second agent tick that arrives too late.");
    expect(lost).toBe(false);

    const afterLoss = await db.execute({
      args: [TRACK_ID],
      sql: "select updated_at from findings where track_id = ?",
    });
    expect(afterLoss.rows[0]?.updated_at).toBe(OLD);
  });

  it("throws not_found for a track that does not exist", async () => {
    const { fillEmptyNote } = await import("./track-update");

    await expect(fillEmptyNote("zzzzzzzzzzzzzzzzzzzzzz", "no such finding")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });
});
