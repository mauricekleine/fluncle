import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";
import { type NoteEcho } from "./note";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const TRACK_ID = "abcdefghij0123456789AB";
const CATALOGUE_ID = "zyxwvutsrq9876543210ZY";

const THRESHOLDS = { maxOverlap: 0.3, minPhraseWords: 4 };

const echo = (overrides: Partial<NoteEcho> = {}): NoteEcho => ({
  echoes: true,
  logId: "027.2.8R",
  note: "My shoulders dropped before the break even settled.",
  overlap: 0.34,
  phrase: "my shoulders dropped before",
  ...overrides,
});

async function noteOf(trackId: string): Promise<null | string> {
  const result = await db.execute({
    args: [trackId],
    sql: "select note from findings where track_id = ?",
  });

  return (result.rows[0]?.note as null | string) ?? null;
}

describe("the echo gate's ledger", () => {
  beforeEach(async () => {
    db = await createIntegrationDb();
    await seedTrack(db, { logId: "004.7.2I", trackId: TRACK_ID });
  });

  it("carries the partial unique index that bounds it (it survives the migration chain)", async () => {
    const result = await db.execute(
      `select sql from sqlite_master
       where type = 'index' and name = 'note_rejections_open_track_idx'`,
    );
    const ddl = result.rows[0]?.sql;
    const sql = typeof ddl === "string" ? ddl : "";

    expect(sql).toContain("UNIQUE INDEX");

    expect(sql.toLowerCase()).toContain("where");
    expect(sql.toLowerCase()).toContain("resolved_at");
  });

  it("HOLDS a rejected note — the line, the neighbour, the phrase, the score, the dials", async () => {
    const { listNoteRejections, recordNoteRejection } = await import("./note-rejections");

    await recordNoteRejection(
      TRACK_ID,
      "My shoulders dropped before I knew the tune had turned.",
      echo(),
      THRESHOLDS,
    );

    const [held] = await listNoteRejections({ open: true });

    expect(held?.note).toBe("My shoulders dropped before I knew the tune had turned.");

    expect(held?.neighborLogId).toBe("027.2.8R");
    expect(held?.neighborNote).toBe("My shoulders dropped before the break even settled.");
    expect(held?.phrase).toBe("my shoulders dropped before");
    expect(held?.overlap).toBeCloseTo(0.34);

    expect(held?.minPhraseWords).toBe(4);
    expect(held?.maxOverlap).toBeCloseTo(0.3);
  });

  it("keeps ONE open rejection per finding — a re-bounce updates it and counts, never appends", async () => {
    const { listNoteRejections, recordNoteRejection } = await import("./note-rejections");

    await recordNoteRejection(TRACK_ID, "The first line it tried.", echo(), THRESHOLDS);
    await recordNoteRejection(TRACK_ID, "The second line it tried.", echo(), THRESHOLDS);
    await recordNoteRejection(TRACK_ID, "The third line it tried.", echo(), THRESHOLDS);

    const open = await listNoteRejections({ open: true });

    expect(open).toHaveLength(1);

    expect(open[0]?.note).toBe("The third line it tried.");
    expect(open[0]?.attempts).toBe(3);
  });

  it("ACCEPTING a held note writes it onto the finding and settles the row", async () => {
    const { listNoteRejections, recordNoteRejection, resolveNoteRejection } =
      await import("./note-rejections");

    await recordNoteRejection(TRACK_ID, "A line the operator judges good.", echo(), THRESHOLDS);
    const [held] = await listNoteRejections({ open: true });

    const result = await resolveNoteRejection(held?.id ?? "", "accepted");

    expect(result.skipped).toBe(false);
    expect(await noteOf(TRACK_ID)).toBe("A line the operator judges good.");

    expect(await listNoteRejections({ open: true })).toHaveLength(0);
    expect((await listNoteRejections({ open: false }))[0]?.resolution).toBe("accepted");
  });

  it("NEVER clobbers an operator note — accepting a held note when one exists is a no-op", async () => {
    const { listNoteRejections, recordNoteRejection, resolveNoteRejection } =
      await import("./note-rejections");

    await recordNoteRejection(TRACK_ID, "The agent's held line.", echo(), THRESHOLDS);
    const [held] = await listNoteRejections({ open: true });

    await db.execute({
      args: ["An operator's hand-set note that must win.", TRACK_ID],
      sql: "update findings set note = ? where track_id = ?",
    });

    const result = await resolveNoteRejection(held?.id ?? "", "accepted");

    expect(result.skipped).toBe(true);
    expect(await noteOf(TRACK_ID)).toBe("An operator's hand-set note that must win.");

    expect(await listNoteRejections({ open: true })).toHaveLength(0);
  });

  it("DISCARDING leaves the finding note-less and blocks no future draft", async () => {
    const { listNoteRejections, recordNoteRejection, resolveNoteRejection } =
      await import("./note-rejections");
    const { fillEmptyNote } = await import("./track-update");

    await recordNoteRejection(TRACK_ID, "A line the gate was right about.", echo(), THRESHOLDS);
    const [held] = await listNoteRejections({ open: true });

    await resolveNoteRejection(held?.id ?? "", "discarded");

    expect(await noteOf(TRACK_ID)).toBeNull();
    expect((await listNoteRejections({ open: false }))[0]?.resolution).toBe("discarded");

    expect(await fillEmptyNote(TRACK_ID, "The line that finally landed on its own.")).toBe(true);
  });

  it("stops being OPEN the moment a note lands, by any path", async () => {
    const { listNoteRejections, recordNoteRejection } = await import("./note-rejections");
    const { fillEmptyNote } = await import("./track-update");

    await recordNoteRejection(TRACK_ID, "A line the gate held.", echo(), THRESHOLDS);
    expect(await listNoteRejections({ open: true })).toHaveLength(1);

    expect(await fillEmptyNote(TRACK_ID, "The line that finally landed on its own.")).toBe(true);

    expect(await listNoteRejections({ open: true })).toHaveLength(0);
  });

  it("refuses to rule twice on the same held note", async () => {
    const { listNoteRejections, recordNoteRejection, resolveNoteRejection } =
      await import("./note-rejections");

    await recordNoteRejection(TRACK_ID, "A line ruled on once.", echo(), THRESHOLDS);
    const [held] = await listNoteRejections({ open: true });
    await resolveNoteRejection(held?.id ?? "", "discarded");

    await expect(resolveNoteRejection(held?.id ?? "", "accepted")).rejects.toMatchObject({
      code: "already_resolved",
    });
  });

  it("a CATALOGUE track never surfaces in the ledger, even with a row against it", async () => {
    const { listNoteRejections, recordNoteRejection } = await import("./note-rejections");
    await seedCatalogueTrack(db, { trackId: CATALOGUE_ID });

    await recordNoteRejection(
      CATALOGUE_ID,
      "A note about an uncertified track.",
      echo(),
      THRESHOLDS,
    );

    expect(await listNoteRejections({ open: true })).toHaveLength(0);
    expect(await listNoteRejections({ trackId: CATALOGUE_ID })).toHaveLength(0);
  });
});

describe("the echo gate's dials", () => {
  beforeEach(async () => {
    db = await createIntegrationDb();
  });

  it("defaults when unset, and a retune is read back on the very next gating run", async () => {
    const { getNoteEchoThresholds, setNoteEchoThresholds } = await import("./note-rejections");

    expect(await getNoteEchoThresholds()).toEqual({ maxOverlap: 0.3, minPhraseWords: 4 });

    await setNoteEchoThresholds({ maxOverlap: 0.4 });

    expect(await getNoteEchoThresholds()).toEqual({ maxOverlap: 0.4, minPhraseWords: 4 });
  });

  it("refuses an absurd dial — the gate can be wrong, never disabled by a typo", async () => {
    const { setNoteEchoThresholds } = await import("./note-rejections");

    await expect(setNoteEchoThresholds({ maxOverlap: 0 })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(setNoteEchoThresholds({ minPhraseWords: 1 })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("degrades a corrupted KV value to the default rather than opening the gate", async () => {
    const { getNoteEchoThresholds } = await import("./note-rejections");
    const { setSetting } = await import("./settings");

    await setSetting("note_echo_max_overlap", "not-a-number");

    expect((await getNoteEchoThresholds()).maxOverlap).toBe(0.3);
  });
});
