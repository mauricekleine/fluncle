import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";
import { type NoteEcho } from "./note";

// THE ECHO GATE'S LEDGER, against the real schema.
//
// The gate refuses to STORE an auto-note that echoes a sonic neighbour. #502 shipped that
// refusal SILENT — the line went to /dev/null — which left the operator unable to read what
// was binned, unable to judge whether the gate was right, and unable to prove its thresholds
// wrong, because the evidence was the thing being destroyed. These cases pin the fix.
//
// They run against the REAL in-memory libSQL schema (the generated migrations), because the
// two properties that matter most are SQL properties a mock could not prove:
//   - the PARTIAL UNIQUE INDEX that bounds the ledger (one OPEN rejection per finding, so a
//     stubbornly-echoing finding cannot write hundreds of rows a day), and
//   - the FILL-EMPTY-ONLY predicate that accepting a held note takes, so an operator note
//     can never be clobbered by a line the operator himself is only just approving.

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

  it("HOLDS a rejected note — the line, the neighbour, the phrase, the score, the dials", async () => {
    const { listNoteRejections, recordNoteRejection } = await import("./note-rejections");

    await recordNoteRejection(
      TRACK_ID,
      "My shoulders dropped before I knew the tune had turned.",
      echo(),
      THRESHOLDS,
    );

    const [held] = await listNoteRejections({ open: true });

    // The whole point: the operator can READ what the model wrote.
    expect(held?.note).toBe("My shoulders dropped before I knew the tune had turned.");
    // And WHY it was refused — with the other half of the comparison, not just a verdict.
    expect(held?.neighborLogId).toBe("027.2.8R");
    expect(held?.neighborNote).toBe("My shoulders dropped before the break even settled.");
    expect(held?.phrase).toBe("my shoulders dropped before");
    expect(held?.overlap).toBeCloseTo(0.34);
    // And the dials THAT rejection was judged against — snapshotted, so a later retune
    // cannot silently rewrite the meaning of this row.
    expect(held?.minPhraseWords).toBe(4);
    expect(held?.maxOverlap).toBeCloseTo(0.3);
  });

  it("keeps ONE open rejection per finding — a re-bounce updates it and counts, never appends", async () => {
    const { listNoteRejections, recordNoteRejection } = await import("./note-rejections");

    // The sweep re-authors once per tick, and a note-less finding stays queued forever. If
    // each bounce appended, one stubborn finding would write hundreds of rows a day and
    // raise hundreds of queue rows. The partial unique index makes that impossible.
    await recordNoteRejection(TRACK_ID, "The first line it tried.", echo(), THRESHOLDS);
    await recordNoteRejection(TRACK_ID, "The second line it tried.", echo(), THRESHOLDS);
    await recordNoteRejection(TRACK_ID, "The third line it tried.", echo(), THRESHOLDS);

    const open = await listNoteRejections({ open: true });

    expect(open).toHaveLength(1);
    // The FRESHEST line is the one held — the later attempts are authored knowing the
    // earlier echo, so the last one is the model's best effort.
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
    // The row settles (it leaves the queue) but is KEPT — it is the evidence behind a retune.
    expect(await listNoteRejections({ open: true })).toHaveLength(0);
    expect((await listNoteRejections({ open: false }))[0]?.resolution).toBe("accepted");
  });

  // THE CARDINAL RAIL, still absolute. Accepting a held note takes the SAME atomic
  // fill-empty-only predicate the agent's own write takes — so a note the operator wrote by
  // hand in the meantime wins, even against his own acceptance of the agent's line.
  it("NEVER clobbers an operator note — accepting a held note when one exists is a no-op", async () => {
    const { listNoteRejections, recordNoteRejection, resolveNoteRejection } =
      await import("./note-rejections");

    await recordNoteRejection(TRACK_ID, "The agent's held line.", echo(), THRESHOLDS);
    const [held] = await listNoteRejections({ open: true });

    // An operator note lands after the rejection was held.
    await db.execute({
      args: ["An operator's hand-set note that must win.", TRACK_ID],
      sql: "update findings set note = ? where track_id = ?",
    });

    const result = await resolveNoteRejection(held?.id ?? "", "accepted");

    // The write matched no row: reported honestly, and the operator's note is untouched.
    expect(result.skipped).toBe(true);
    expect(await noteOf(TRACK_ID)).toBe("An operator's hand-set note that must win.");
    // The rejection still settles — the held line is moot now that the finding has a note.
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

    // The ledger OBSERVES the pipeline, it never gates it: the next sweep tick is free to
    // author a better line, and it fills the note normally.
    expect(await fillEmptyNote(TRACK_ID, "The line that finally landed on its own.")).toBe(true);
  });

  // THE TRUST RULE (docs/admin-shell.md): never surface a row the system can't confirm is
  // actionable. A held line is MOOT the moment a note stands on the finding — fill-empty-only
  // means it could never replace that note anyway, so there is nothing left to rule on. The
  // open read carries note-emptiness as a PREDICATE rather than trusting a write path to come
  // back and tidy up, so the row cannot go stale whichever path filled the note.
  it("stops being OPEN the moment a note lands, by any path", async () => {
    const { listNoteRejections, recordNoteRejection } = await import("./note-rejections");
    const { fillEmptyNote } = await import("./track-update");

    await recordNoteRejection(TRACK_ID, "A line the gate held.", echo(), THRESHOLDS);
    expect(await listNoteRejections({ open: true })).toHaveLength(1);

    // The ledger never GATES the pipeline: the next sweep tick authors a line that clears the
    // gate, and it fills the note normally — the held rejection blocks nothing.
    expect(await fillEmptyNote(TRACK_ID, "The line that finally landed on its own.")).toBe(true);

    // And now the held row is no longer actionable, so it leaves the queue on its own.
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

  // THE CATALOGUE RAIL. Every finding read drives through the `findings ⋈ tracks` INNER
  // join, so a track Fluncle never certified cannot surface here even if a row existed for
  // it. Fluncle does not speak about a track he has not certified — and the ledger is a
  // place where he speaks.
  it("a CATALOGUE track never surfaces in the ledger, even with a row against it", async () => {
    const { listNoteRejections, recordNoteRejection } = await import("./note-rejections");
    await seedCatalogueTrack(db, { trackId: CATALOGUE_ID });

    // Force a row in directly — the handler can't reach this (requireTrack 404s an
    // uncertified track long before a note is gated), so this proves the READ's join is the
    // rail, not merely the write path's guard.
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

// ── The tunable dials, against the real `settings` KV ─────────────────────────────

describe("the echo gate's dials", () => {
  beforeEach(async () => {
    db = await createIntegrationDb();
  });

  it("defaults when unset, and a retune is read back on the very next gating run", async () => {
    const { getNoteEchoThresholds, setNoteEchoThresholds } = await import("./note-rejections");

    expect(await getNoteEchoThresholds()).toEqual({ maxOverlap: 0.3, minPhraseWords: 4 });

    await setNoteEchoThresholds({ maxOverlap: 0.4 });

    // A flip, not a deploy: the next sweep tick reads this.
    expect(await getNoteEchoThresholds()).toEqual({ maxOverlap: 0.4, minPhraseWords: 4 });
  });

  it("refuses an absurd dial — the gate can be wrong, never disabled by a typo", async () => {
    const { setNoteEchoThresholds } = await import("./note-rejections");

    // maxOverlap 0 would reject every note; minPhraseWords 1 would reject every sentence
    // sharing a word. The gate must fail toward its calibrated defaults, never open or shut.
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

    // A hand-edited or botched KV write must not silently disable the rail.
    await setSetting("note_echo_max_overlap", "not-a-number");

    expect((await getNoteEchoThresholds()).maxOverlap).toBe(0.3);
  });
});
