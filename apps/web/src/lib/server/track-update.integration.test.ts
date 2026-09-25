import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedTrack } from "./integration-db";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return {
    ...actual,
    getDb: () => Promise.resolve(db),
  };
});

const TRACK_ID = "abcdefghij0123456789AB";

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

  it("stamps note_prompt_version in the same statement as the note (and NULL when unstamped)", async () => {
    const { fillEmptyNote } = await import("./track-update");

    const filled = await fillEmptyNote(TRACK_ID, "Pure rolling menace, patient and mean.", 5);

    expect(filled).toBe(true);
    const stamped = await db.execute({
      args: [TRACK_ID],
      sql: "select note_prompt_version from findings where track_id = ?",
    });
    expect(stamped.rows[0]?.note_prompt_version).toBe(5);

    await setNote(TRACK_ID, null);
    await fillEmptyNote(TRACK_ID, "An operator's line, typed by hand.");
    const unstamped = await db.execute({
      args: [TRACK_ID],
      sql: "select note_prompt_version from findings where track_id = ?",
    });
    expect(unstamped.rows[0]?.note_prompt_version).toBeNull();
  });

  it("fills a WHITESPACE-ONLY (spaces) note — trim() counts it as empty (returns true, stores)", async () => {
    const { fillEmptyNote } = await import("./track-update");
    await setNote(TRACK_ID, "     ");

    const filled = await fillEmptyNote(TRACK_ID, "A late roller that would not let go.");

    expect(filled).toBe(true);
    expect(await noteOf(TRACK_ID)).toBe("A late roller that would not let go.");
  });

  it("does NOT clobber an EXISTING note — returns false, the stored note is unchanged", async () => {
    const { fillEmptyNote } = await import("./track-update");

    await setNote(TRACK_ID, "An operator's hand-set note that must win.");

    const filled = await fillEmptyNote(TRACK_ID, "The agent's note that must lose the race.");

    expect(filled).toBe(false);

    expect(await noteOf(TRACK_ID)).toBe("An operator's hand-set note that must win.");
  });

  it("bumps updated_at when it fills, and NOT when it loses the race", async () => {
    const { fillEmptyNote } = await import("./track-update");

    const OLD = "2000-01-01T00:00:00.000Z";
    await db.execute({
      args: [OLD, TRACK_ID],
      sql: "update findings set updated_at = ? where track_id = ?",
    });

    const filled = await fillEmptyNote(TRACK_ID, "First light, and the drop just holds.");
    expect(filled).toBe(true);

    const afterFill = await db.execute({
      args: [TRACK_ID],
      sql: "select updated_at from findings where track_id = ?",
    });
    const bumped = afterFill.rows[0]?.updated_at as string;
    expect(bumped).not.toBe(OLD);

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
