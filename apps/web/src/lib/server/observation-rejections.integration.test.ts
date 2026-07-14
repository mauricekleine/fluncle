import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";
import { type ObservationEcho } from "./observation-echo";

// THE OBSERVATION ECHO GATE'S LEDGER, against the real schema — the spoken sibling of
// note-rejections.integration.test.ts, mirroring its cases one for one.
//
// The observations were the worst-measured generated family (echoing 59/61, "…enjoy
// cosmonauts" verbatim closing 32/61 — docs/planning/homogenisation-evidence.md, 2026-07-14)
// and the only written family with NO rail. The gate this ledger observes refuses to RENDER a
// script that echoes a sonic neighbour's script — and, like the note gate before it, it must
// refuse in the open: the script is held, the operator rules.
//
// These run against the REAL in-memory libSQL schema (the generated migrations), because the
// properties that matter most are SQL properties a mock could not prove: the partial unique
// index that bounds the ledger, and the moot-when-voiced predicate on the open read.
//
// The one impure edge — accepting a held script RENDERS it (Cartesia + R2) — is mocked at the
// `renderAndStoreObservation` seam, which is exactly the seam the resolve path shares with the
// observe_track handler. The mock records what it was asked to render; the DB rows stay real.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

// The render seam: accepting a held script must call this with the finding + the held script.
// Mocked because a unit test cannot (and must not) spend a Cartesia render; the seam is shared
// with the observe handler, so the contract it proves is the one production takes.
const renderMock = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) =>
    Promise.resolve({
      audioUrl: "https://found.example/004.7.2I/observation.mp3",
      durationMs: 32000,
      generatedAt: "2026-07-14T00:00:00.000Z",
      jsonUrl: "https://found.example/004.7.2I/observation.json",
      logId: "004.7.2I",
      textUrl: "https://found.example/004.7.2I/observation.txt",
      trackId: "abcdefghij0123456789AB",
      voiceId: "voice",
    }),
  ),
);

vi.mock("./observation-render", () => ({
  renderAndStoreObservation: renderMock,
}));

const TRACK_ID = "abcdefghij0123456789AB";
const CATALOGUE_ID = "zyxwvutsrq9876543210ZY";

const THRESHOLDS = { maxOverlap: 0.3, minPhraseWords: 4 };

const echo = (overrides: Partial<ObservationEcho> = {}): ObservationEcho => ({
  echoes: true,
  logId: "027.2.8R",
  overlap: 0.34,
  phrase: "my shoulders went before",
  script: "My shoulders went before I'd clocked the coordinate.",
  ...overrides,
});

async function voiceOf(trackId: string): Promise<null | string> {
  const result = await db.execute({
    args: [trackId],
    sql: "select observation_audio_url from findings where track_id = ?",
  });

  return (result.rows[0]?.observation_audio_url as null | string) ?? null;
}

describe("the observation echo gate's ledger", () => {
  beforeEach(async () => {
    db = await createIntegrationDb();
    renderMock.mockClear();
    await seedTrack(db, { logId: "004.7.2I", trackId: TRACK_ID });
  });

  // The partial unique index is LOAD-BEARING (the note ledger's precedent, same reasoning):
  // it bounds the ledger by the archive rather than by the cron's tick rate, and the upsert's
  // `on conflict (track_id) where resolved_at is null` cannot work without it.
  it("carries the partial unique index that bounds it (it survives the migration chain)", async () => {
    const result = await db.execute(
      `select sql from sqlite_master
       where type = 'index' and name = 'observation_rejections_open_track_idx'`,
    );
    const ddl = result.rows[0]?.sql;
    const sql = typeof ddl === "string" ? ddl : "";

    expect(sql).toContain("UNIQUE INDEX");
    expect(sql.toLowerCase()).toContain("where");
    expect(sql.toLowerCase()).toContain("resolved_at");
  });

  it("HOLDS a rejected script — the read, the neighbour, the phrase, the score, the dials", async () => {
    const { listObservationRejections, recordObservationRejection } =
      await import("./observation-rejections");

    await recordObservationRejection(
      TRACK_ID,
      "My shoulders went before I knew the tune had turned.",
      echo(),
      THRESHOLDS,
    );

    const [held] = await listObservationRejections({ open: true });

    // The whole point: the operator can READ what the model wrote.
    expect(held?.script).toBe("My shoulders went before I knew the tune had turned.");
    // And WHY it was refused — with the other half of the comparison, not just a verdict.
    expect(held?.neighborLogId).toBe("027.2.8R");
    expect(held?.neighborScript).toBe("My shoulders went before I'd clocked the coordinate.");
    expect(held?.phrase).toBe("my shoulders went before");
    expect(held?.overlap).toBeCloseTo(0.34);
    // And the dials THAT rejection was judged against — snapshotted, so a later retune
    // cannot silently rewrite the meaning of this row.
    expect(held?.minPhraseWords).toBe(4);
    expect(held?.maxOverlap).toBeCloseTo(0.3);
  });

  it("keeps ONE open rejection per finding — a re-bounce updates it and counts, never appends", async () => {
    const { listObservationRejections, recordObservationRejection } =
      await import("./observation-rejections");

    await recordObservationRejection(TRACK_ID, "The first read it tried.", echo(), THRESHOLDS);
    await recordObservationRejection(TRACK_ID, "The second read it tried.", echo(), THRESHOLDS);
    await recordObservationRejection(TRACK_ID, "The third read it tried.", echo(), THRESHOLDS);

    const open = await listObservationRejections({ open: true });

    expect(open).toHaveLength(1);
    // The FRESHEST read is the one held — the later attempts are authored knowing the earlier
    // echo, so the last one is the model's best effort.
    expect(open[0]?.script).toBe("The third read it tried.");
    expect(open[0]?.attempts).toBe(3);
  });

  it("ACCEPTING a held script RENDERS it through the shared render seam and settles the row", async () => {
    const { listObservationRejections, recordObservationRejection, resolveObservationRejection } =
      await import("./observation-rejections");

    await recordObservationRejection(
      TRACK_ID,
      "A read the operator judges good.",
      echo(),
      THRESHOLDS,
    );
    const [held] = await listObservationRejections({ open: true });

    const result = await resolveObservationRejection(held?.id ?? "", "accepted");

    expect(result.skipped).toBe(false);
    // The render seam was handed exactly the held script, for exactly this finding — with NULL
    // provenance (an operator override, not a registry-prompt authorship).
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: TRACK_ID }),
      "A read the operator judges good.",
      expect.objectContaining({ promptVersion: null }),
    );
    // The row settles (it leaves the queue) but is KEPT — the evidence behind a retune.
    expect(await listObservationRejections({ open: true })).toHaveLength(0);
    expect((await listObservationRejections({ open: false }))[0]?.resolution).toBe("accepted");
  });

  // The spoken analogue of the note ledger's fill-empty-only rail: an observation that landed
  // since the hold (a fresh script cleared the gate, or the operator rendered one) stands, and
  // accepting the held script must not waste a render overwriting it.
  it("NEVER re-renders over a standing observation — accepting when one exists is a no-op", async () => {
    const { listObservationRejections, recordObservationRejection, resolveObservationRejection } =
      await import("./observation-rejections");

    await recordObservationRejection(TRACK_ID, "The agent's held read.", echo(), THRESHOLDS);
    // Fetch the held row BEFORE the observation lands (the open read goes moot after).
    const [held] = await listObservationRejections({ open: true });

    // An observation lands after the rejection was held.
    await db.execute({
      args: ["https://found.example/004.7.2I/observation.mp3", TRACK_ID],
      sql: "update findings set observation_audio_url = ? where track_id = ?",
    });

    // The open read already treats the row as moot (never surface a non-actionable row)…
    expect(await listObservationRejections({ open: true })).toHaveLength(0);

    // …and a direct ruling on it still refuses to spend a render.
    const result = await resolveObservationRejection(held?.id ?? "", "accepted");

    expect(result.skipped).toBe(true);
    expect(renderMock).not.toHaveBeenCalled();
    expect(await voiceOf(TRACK_ID)).toBe("https://found.example/004.7.2I/observation.mp3");
  });

  it("DISCARDING leaves the finding unvoiced and blocks no future render", async () => {
    const { listObservationRejections, recordObservationRejection, resolveObservationRejection } =
      await import("./observation-rejections");

    await recordObservationRejection(
      TRACK_ID,
      "A read the gate was right about.",
      echo(),
      THRESHOLDS,
    );
    const [held] = await listObservationRejections({ open: true });

    await resolveObservationRejection(held?.id ?? "", "discarded");

    expect(renderMock).not.toHaveBeenCalled();
    expect(await voiceOf(TRACK_ID)).toBeNull();
    expect((await listObservationRejections({ open: false }))[0]?.resolution).toBe("discarded");
  });

  it("refuses to rule twice on the same held observation", async () => {
    const { listObservationRejections, recordObservationRejection, resolveObservationRejection } =
      await import("./observation-rejections");

    await recordObservationRejection(TRACK_ID, "A read ruled on once.", echo(), THRESHOLDS);
    const [held] = await listObservationRejections({ open: true });
    await resolveObservationRejection(held?.id ?? "", "discarded");

    await expect(resolveObservationRejection(held?.id ?? "", "accepted")).rejects.toMatchObject({
      code: "already_resolved",
    });
  });

  // THE CATALOGUE RAIL: the read drives through the `findings ⋈ tracks` INNER join, so a track
  // Fluncle never certified cannot surface here even with a row against it.
  it("a CATALOGUE track never surfaces in the ledger, even with a row against it", async () => {
    const { listObservationRejections, recordObservationRejection } =
      await import("./observation-rejections");
    await seedCatalogueTrack(db, { trackId: CATALOGUE_ID });

    await recordObservationRejection(
      CATALOGUE_ID,
      "A read about an uncertified track.",
      echo(),
      THRESHOLDS,
    );

    expect(await listObservationRejections({ open: true })).toHaveLength(0);
    expect(await listObservationRejections({ trackId: CATALOGUE_ID })).toHaveLength(0);
  });
});

// ── The tunable dials, against the real `settings` KV ─────────────────────────────

describe("the observation echo gate's dials", () => {
  beforeEach(async () => {
    db = await createIntegrationDb();
  });

  it("defaults when unset, and a retune is read back on the very next gating run", async () => {
    const { getObservationEchoThresholds, setObservationEchoThresholds } =
      await import("./observation-rejections");

    expect(await getObservationEchoThresholds()).toEqual({ maxOverlap: 0.3, minPhraseWords: 4 });

    await setObservationEchoThresholds({ maxOverlap: 0.4 });

    expect(await getObservationEchoThresholds()).toEqual({ maxOverlap: 0.4, minPhraseWords: 4 });
  });

  it("keeps its OWN keys — retuning the observation gate leaves the note gate untouched", async () => {
    const { setObservationEchoThresholds } = await import("./observation-rejections");
    const { getNoteEchoThresholds } = await import("./note-rejections");

    await setObservationEchoThresholds({ maxOverlap: 0.5, minPhraseWords: 6 });

    // The two written families' corpora differ (a 40s script vs a one-line note), so their
    // honest thresholds can drift apart — the dials must be independent.
    expect(await getNoteEchoThresholds()).toEqual({ maxOverlap: 0.3, minPhraseWords: 4 });
  });

  it("refuses an absurd dial — the gate can be wrong, never disabled by a typo", async () => {
    const { setObservationEchoThresholds } = await import("./observation-rejections");

    await expect(setObservationEchoThresholds({ maxOverlap: 0 })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(setObservationEchoThresholds({ minPhraseWords: 1 })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("degrades a corrupted KV value to the default rather than opening the gate", async () => {
    const { getObservationEchoThresholds } = await import("./observation-rejections");
    const { setSetting } = await import("./settings");

    await setSetting("observation_echo_max_overlap", "not-a-number");

    expect((await getObservationEchoThresholds()).maxOverlap).toBe(0.3);
  });
});
