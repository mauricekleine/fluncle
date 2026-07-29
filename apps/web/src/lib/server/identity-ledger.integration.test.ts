// The identity ledger's two attempt stamps (RFC dnb-identity-graph, Unit 1 items 1–2), proven
// against the REAL migrated schema on an in-memory libSQL engine.
//
// It is an INTEGRATION test because every claim here is SQL, and a mocked-DB test would pass while
// any of it was broken:
//
//   - THE MIGRATION ITSELF — `tracks.isrc_attempted_at` and the four `tracks.backfill_discogs_*`
//     columns. If the migration did not apply, every statement below naming them would throw here,
//     which is the guard we want, since `deploy:gate` runs this suite;
//   - THE WRITE PATHS — the stamp is only real if the SAME statement that fills (or declines to
//     fill) the identifier writes it, on a HIT and on a CLEAN MISS alike. A stamp that only lands
//     on hits would leave the honest negative — the whole point of the column — unsayable;
//   - THE THROTTLE RAIL — a rate-limited vendor is NOT an answer, and must leave the row
//     untouched. This is the one behaviour that is easy to get backwards and impossible to see
//     later, since a wrong stamp is indistinguishable from a right one after the fact;
//   - THE LEGACY BACKFILL — idempotent, and never clobbering a stamp a real attempt has written.
//
// The vendors are mocked (there is no network): MusicBrainz and Deezer answer from fixtures.

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { backfillIdentityLedger } from "../../../scripts/backfill-identity-ledger";
import { recoverIsrcViaDeezer } from "./anchor";
import { createIntegrationDb } from "./integration-db";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
});

/** The ledger columns as the envelope will read them. */
type LedgerRow = {
  backfill_discogs_attempted_at: null | string;
  backfill_discogs_attempts: number;
  backfill_discogs_done_at: null | string;
  backfill_discogs_failures: number;
  in_master_id: null | number;
  in_release_id: null | number;
  isrc: null | string;
  isrc_attempted_at: null | string;
};

async function ledger(trackId: string): Promise<LedgerRow> {
  const result = await db.execute({
    args: [trackId],
    sql: `select isrc, isrc_attempted_at, in_release_id, in_master_id,
                 backfill_discogs_attempted_at, backfill_discogs_attempts,
                 backfill_discogs_done_at, backfill_discogs_failures
          from tracks where track_id = ?`,
  });
  const row = result.rows[0];

  if (!row) {
    throw new Error(`no track ${trackId}`);
  }

  return row as unknown as LedgerRow;
}

/** A bare catalogue row (no `findings` row), as history left it. */
async function insertCatalogueTrack(
  trackId: string,
  fields: { discogsRelease?: number; isrc?: string } = {},
): Promise<void> {
  await db.execute({
    args: [trackId, fields.isrc ?? null, fields.discogsRelease ?? null],
    sql: `insert into tracks (track_id, title, artists_json, duration_ms, isrc, in_release_id)
          values (?, 'Tune', '["Artist"]', 300000, ?, ?)`,
  });
}

/** A certified row: a `tracks` row plus the `findings` row that carries its `added_at`. */
async function insertFinding(
  trackId: string,
  addedAt: string,
  fields: { discogsRelease?: number; isrc?: string } = {},
): Promise<void> {
  await db.execute({
    args: [trackId, fields.isrc ?? null, fields.discogsRelease ?? null],
    sql: `insert into tracks (track_id, title, artists_json, duration_ms, isrc, in_release_id,
                              is_catalogue)
          values (?, 'Tune', '["Artist"]', 300000, ?, ?, 0)`,
  });
  await db.execute({
    args: [trackId, addedAt],
    sql: `insert into findings (track_id, log_id, added_at, updated_at)
          values (?, '001.A.01', ?, ?)`,
  });
}

describe("the migration", () => {
  it("lands both stamps on `tracks`, nullable and un-defaulted where it matters", async () => {
    await insertCatalogueTrack("mb_1", { isrc: "GBABC1200001" });

    const row = await ledger("mb_1");

    // A row nobody has stamped is `unattempted`, not `absent` — the distinction the columns exist
    // to carry. The two counters read 0 from their DDL default, never null.
    expect(row.isrc_attempted_at).toBeNull();
    expect(row.backfill_discogs_attempted_at).toBeNull();
    expect(row.backfill_discogs_done_at).toBeNull();
    expect(row.backfill_discogs_attempts).toBe(0);
    expect(row.backfill_discogs_failures).toBe(0);
  });
});

describe("the Deezer-recovery rung (anchor.ts § recoverIsrcViaDeezer)", () => {
  const row = { artists: ["Calibre"], durationMs: 300_000, title: "Mr Right On" };

  it("stamps on a HIT, in the same statement that fills the ISRC", async () => {
    await insertCatalogueTrack("mb_hit");

    const recovered = await recoverIsrcViaDeezer(
      "mb_hit",
      db,
      row.artists,
      row.title,
      row.durationMs,
      [{ artistName: "Calibre", durationMs: 300_000, isrc: "GBABC1200002", title: "Mr Right On" }],
    );

    expect(recovered).toBe("GBABC1200002");

    const after = await ledger("mb_hit");

    expect(after.isrc).toBe("GBABC1200002");
    expect(after.isrc_attempted_at).not.toBeNull();
  });

  it("stamps on a CLEAN MISS — Deezer answered, nothing cleared the gate", async () => {
    await insertCatalogueTrack("mb_miss");

    // A candidate that is a different recording entirely: the duration is nowhere near the row's.
    const recovered = await recoverIsrcViaDeezer(
      "mb_miss",
      db,
      row.artists,
      row.title,
      row.durationMs,
      [{ artistName: "Calibre", durationMs: 90_000, isrc: "GBABC1200003", title: "Mr Right On" }],
    );

    expect(recovered).toBeUndefined();

    const after = await ledger("mb_miss");

    // The honest negative: no ISRC, but we looked. Nothing else on the row moved.
    expect(after.isrc).toBeNull();
    expect(after.isrc_attempted_at).not.toBeNull();
  });

  it("leaves the row UNTOUCHED when the search came back empty (a throttle is not an answer)", async () => {
    await insertCatalogueTrack("mb_empty");

    const recovered = await recoverIsrcViaDeezer(
      "mb_empty",
      db,
      row.artists,
      row.title,
      row.durationMs,
      [],
    );

    expect(recovered).toBeUndefined();
    expect((await ledger("mb_empty")).isrc_attempted_at).toBeNull();
  });

  it("leaves the row UNTOUCHED when there is no identity to verify against", async () => {
    await insertCatalogueTrack("mb_unverifiable");

    const recovered = await recoverIsrcViaDeezer("mb_unverifiable", db, [], "", 0, [
      { artistName: "Calibre", durationMs: 300_000, isrc: "GBABC1200004", title: "Mr Right On" },
    ]);

    expect(recovered).toBeUndefined();
    expect((await ledger("mb_unverifiable")).isrc_attempted_at).toBeNull();
  });

  it("never overwrites a real ISRC, and re-stamps the attempt", async () => {
    await insertCatalogueTrack("mb_held", { isrc: "GBABC1200005" });

    await recoverIsrcViaDeezer("mb_held", db, row.artists, row.title, row.durationMs, [
      { artistName: "Calibre", durationMs: 300_000, isrc: "GBABC1299999", title: "Mr Right On" },
    ]);

    const after = await ledger("mb_held");

    expect(after.isrc).toBe("GBABC1200005");
    expect(after.isrc_attempted_at).not.toBeNull();
  });
});

describe("the legacy backfill (scripts/backfill-identity-ledger.ts)", () => {
  it("stamps a certified row from its finding's added_at — the attempt's own instant", async () => {
    await insertFinding("sp_1", "2025-03-04T05:06:07.000Z", {
      discogsRelease: 4242,
      isrc: "GBABC1200010",
    });

    const result = await backfillIdentityLedger(db, "2026-07-29T00:00:00.000Z");

    expect(result).toEqual({ discogsStamped: 1, isrcStamped: 1 });

    const after = await ledger("sp_1");

    expect(after.isrc_attempted_at).toBe("2025-03-04T05:06:07.000Z");
    expect(after.backfill_discogs_attempted_at).toBe("2025-03-04T05:06:07.000Z");
    expect(after.backfill_discogs_done_at).toBe("2025-03-04T05:06:07.000Z");
    expect(after.backfill_discogs_attempts).toBe(1);
  });

  it("stamps a catalogue row at the run's instant — 'filled by then, at the latest'", async () => {
    await insertCatalogueTrack("mb_legacy", { discogsRelease: 99, isrc: "GBABC1200011" });

    await backfillIdentityLedger(db, "2026-07-29T00:00:00.000Z");

    const after = await ledger("mb_legacy");

    expect(after.isrc_attempted_at).toBe("2026-07-29T00:00:00.000Z");
    expect(after.backfill_discogs_done_at).toBe("2026-07-29T00:00:00.000Z");
  });

  it("leaves a row with no identifier honestly unattempted", async () => {
    await insertCatalogueTrack("mb_nothing");
    // An empty-string ISRC is not an ISRC — the `trim(isrc) <> ''` half of the predicate.
    await insertCatalogueTrack("mb_blank", { isrc: "   " });

    const result = await backfillIdentityLedger(db, "2026-07-29T00:00:00.000Z");

    expect(result).toEqual({ discogsStamped: 0, isrcStamped: 0 });
    expect((await ledger("mb_nothing")).isrc_attempted_at).toBeNull();
    expect((await ledger("mb_blank")).isrc_attempted_at).toBeNull();
    expect((await ledger("mb_nothing")).backfill_discogs_attempted_at).toBeNull();
  });

  it("stamps the two identifiers independently", async () => {
    await insertCatalogueTrack("mb_isrc_only", { isrc: "GBABC1200012" });
    await insertCatalogueTrack("mb_discogs_only", { discogsRelease: 7 });

    const result = await backfillIdentityLedger(db, "2026-07-29T00:00:00.000Z");

    expect(result).toEqual({ discogsStamped: 1, isrcStamped: 1 });

    const isrcOnly = await ledger("mb_isrc_only");
    const discogsOnly = await ledger("mb_discogs_only");

    expect(isrcOnly.isrc_attempted_at).not.toBeNull();
    expect(isrcOnly.backfill_discogs_attempted_at).toBeNull();
    expect(discogsOnly.isrc_attempted_at).toBeNull();
    expect(discogsOnly.backfill_discogs_attempted_at).not.toBeNull();
  });

  it("is idempotent — a second run changes nothing", async () => {
    await insertFinding("sp_2", "2025-03-04T05:06:07.000Z", {
      discogsRelease: 11,
      isrc: "GBABC1200013",
    });
    await insertCatalogueTrack("mb_2", { isrc: "GBABC1200014" });

    const first = await backfillIdentityLedger(db, "2026-07-29T00:00:00.000Z");
    const before = [await ledger("sp_2"), await ledger("mb_2")];

    const second = await backfillIdentityLedger(db, "2026-07-30T00:00:00.000Z");
    const after = [await ledger("sp_2"), await ledger("mb_2")];

    expect(first).toEqual({ discogsStamped: 1, isrcStamped: 2 });
    expect(second).toEqual({ discogsStamped: 0, isrcStamped: 0 });
    expect(after).toEqual(before);
  });

  it("never overwrites a stamp a real attempt has already written", async () => {
    await insertCatalogueTrack("mb_stamped", { discogsRelease: 5, isrc: "GBABC1200015" });
    await db.execute({
      args: ["mb_stamped"],
      sql: `update tracks
            set isrc_attempted_at = '2026-01-01T00:00:00.000Z',
                backfill_discogs_attempted_at = '2026-01-01T00:00:00.000Z',
                backfill_discogs_attempts = 3
            where track_id = ?`,
    });

    const result = await backfillIdentityLedger(db, "2026-07-29T00:00:00.000Z");

    expect(result).toEqual({ discogsStamped: 0, isrcStamped: 0 });

    const after = await ledger("mb_stamped");

    expect(after.isrc_attempted_at).toBe("2026-01-01T00:00:00.000Z");
    expect(after.backfill_discogs_attempted_at).toBe("2026-01-01T00:00:00.000Z");
    // The real attempt's count survives — the backfill's floor of 1 never walks it back.
    expect(after.backfill_discogs_attempts).toBe(3);
  });
});
