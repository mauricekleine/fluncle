import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));
const searchDeezerCandidates = vi.hoisted(() => vi.fn());

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

vi.mock("./deezer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./deezer")>();

  return { ...actual, searchDeezerCandidates };
});

import { backfillIdentityLedger } from "../../../scripts/backfill-identity-ledger";
import {
  initializePublicProjectionTestState,
  readPublicProjectionMaintenanceSnapshot,
  settlePublicProjectionTestState,
} from "../../../scripts/lib/public-projection-test-state";
import { recoverIsrcViaDeezer } from "./anchor";
import { createIntegrationDb } from "./integration-db";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
  await initializePublicProjectionTestState(db);
  holder.db = db;
  searchDeezerCandidates.mockReset();
});

type LedgerRow = {
  backfill_discogs_attempted_at: null | string;
  backfill_discogs_attempts: number;
  backfill_discogs_done_at: null | string;
  backfill_discogs_failures: number;
  in_master_id: null | number;
  in_release_id: null | number;
  isrc: null | string;
  isrc_attempted_at: null | string;
  isrc_recovery_attempted_at: null | string;
};

async function ledger(trackId: string): Promise<LedgerRow> {
  const result = await db.execute({
    args: [trackId],
    sql: `select isrc, isrc_attempted_at, isrc_recovery_attempted_at,
                 in_release_id, in_master_id,
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

    expect(row.isrc_attempted_at).toBeNull();
    expect(row.isrc_recovery_attempted_at).toBeNull();
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
    expect(after.isrc_recovery_attempted_at).not.toBeNull();
  });

  it("stamps on a CLEAN MISS — Deezer answered, nothing cleared the gate", async () => {
    await insertCatalogueTrack("mb_miss");

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

    expect(after.isrc).toBeNull();
    expect(after.isrc_attempted_at).not.toBeNull();
    expect(after.isrc_recovery_attempted_at).not.toBeNull();
  });

  it("stamps only the dedicated ledger when a box-supplied search came back clean-empty", async () => {
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
    const after = await ledger("mb_empty");

    expect(after.isrc_attempted_at).toBeNull();
    expect(after.isrc_recovery_attempted_at).not.toBeNull();
  });

  it("a Worker-self-fetched empty settles nothing — a throttle is not an answer", async () => {
    await insertCatalogueTrack("mb_self_empty");
    searchDeezerCandidates.mockResolvedValue([]);

    const recovered = await recoverIsrcViaDeezer(
      "mb_self_empty",
      db,
      row.artists,
      row.title,
      row.durationMs,
    );

    expect(recovered).toBeUndefined();
    expect(searchDeezerCandidates).toHaveBeenCalledOnce();

    const after = await ledger("mb_self_empty");

    expect(after.isrc_attempted_at).toBeNull();
    expect(after.isrc_recovery_attempted_at).toBeNull();
  });

  it("leaves the row UNTOUCHED when there is no identity to verify against", async () => {
    await insertCatalogueTrack("mb_unverifiable");

    const recovered = await recoverIsrcViaDeezer("mb_unverifiable", db, [], "", 0, [
      { artistName: "Calibre", durationMs: 300_000, isrc: "GBABC1200004", title: "Mr Right On" },
    ]);

    expect(recovered).toBeUndefined();
    expect((await ledger("mb_unverifiable")).isrc_attempted_at).toBeNull();
    expect((await ledger("mb_unverifiable")).isrc_recovery_attempted_at).toBeNull();
  });

  it("never overwrites a real ISRC, and re-stamps the attempt", async () => {
    await insertCatalogueTrack("mb_held", { isrc: "GBABC1200005" });

    await recoverIsrcViaDeezer("mb_held", db, row.artists, row.title, row.durationMs, [
      { artistName: "Calibre", durationMs: 300_000, isrc: "GBABC1299999", title: "Mr Right On" },
    ]);

    const after = await ledger("mb_held");

    expect(after.isrc).toBe("GBABC1200005");
    expect(after.isrc_attempted_at).not.toBeNull();
    expect(after.isrc_recovery_attempted_at).not.toBeNull();
  });
});

describe("the legacy backfill (scripts/backfill-identity-ledger.ts)", () => {
  it("stamps a certified row from its finding's added_at — the attempt's own instant", async () => {
    await insertFinding("sp_1", "2025-03-04T05:06:07.000Z", {
      discogsRelease: 4242,
      isrc: "GBABC1200010",
    });

    const result = await backfillIdentityLedger(db, "2026-07-29T00:00:00.000Z");

    expect(result).toEqual({ discogsStamped: 1, isrcStamped: 1, publishAnchorsStamped: 0 });

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

    await insertCatalogueTrack("mb_blank", { isrc: "   " });

    const result = await backfillIdentityLedger(db, "2026-07-29T00:00:00.000Z");

    expect(result).toEqual({ discogsStamped: 0, isrcStamped: 0, publishAnchorsStamped: 0 });
    expect((await ledger("mb_nothing")).isrc_attempted_at).toBeNull();
    expect((await ledger("mb_blank")).isrc_attempted_at).toBeNull();
    expect((await ledger("mb_nothing")).backfill_discogs_attempted_at).toBeNull();
  });

  it("stamps the two identifiers independently", async () => {
    await insertCatalogueTrack("mb_isrc_only", { isrc: "GBABC1200012" });
    await insertCatalogueTrack("mb_discogs_only", { discogsRelease: 7 });

    const result = await backfillIdentityLedger(db, "2026-07-29T00:00:00.000Z");

    expect(result).toEqual({ discogsStamped: 1, isrcStamped: 1, publishAnchorsStamped: 0 });

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
    expect(await readPublicProjectionMaintenanceSnapshot(db)).toEqual({
      aggregate: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      artists: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      repairs: [],
    });
    await settlePublicProjectionTestState(db);
    const ready = await readPublicProjectionMaintenanceSnapshot(db);
    expect(ready).toEqual({
      aggregate: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      artists: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      repairs: [],
    });

    const second = await backfillIdentityLedger(db, "2026-07-30T00:00:00.000Z");
    const after = [await ledger("sp_2"), await ledger("mb_2")];

    expect(first).toEqual({ discogsStamped: 1, isrcStamped: 2, publishAnchorsStamped: 0 });
    expect(second).toEqual({ discogsStamped: 0, isrcStamped: 0, publishAnchorsStamped: 0 });
    expect(after).toEqual(before);
    expect(await readPublicProjectionMaintenanceSnapshot(db)).toEqual(ready);
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

    expect(result).toEqual({ discogsStamped: 0, isrcStamped: 0, publishAnchorsStamped: 0 });

    const after = await ledger("mb_stamped");

    expect(after.isrc_attempted_at).toBe("2026-01-01T00:00:00.000Z");
    expect(after.backfill_discogs_attempted_at).toBe("2026-01-01T00:00:00.000Z");

    expect(after.backfill_discogs_attempts).toBe(3);
  });
});

describe("backfillIdentityLedger — the publish-born anchor provenance", () => {
  async function insertPublishBorn(
    spotifyId: string,
    addedAt: string,
    logId = "004.7.2I",
  ): Promise<void> {
    await db.execute({
      args: [
        spotifyId,
        `spotify:track:${spotifyId}`,
        `https://open.spotify.com/track/${spotifyId}`,
      ],
      sql: `insert into tracks (track_id, title, artists_json, duration_ms, spotify_uri, spotify_url, is_catalogue)
            values (?, 'Tune', '["Artist"]', 300000, ?, ?, 0)`,
    });

    await db.execute({
      args: [spotifyId, logId, addedAt],
      sql: `insert into findings (track_id, log_id, added_at) values (?, ?, ?)`,
    });
  }

  async function provenance(trackId: string) {
    const result = await db.execute({
      args: [trackId],
      sql: `select spotify_anchor_source, spotify_anchor_verified_by, spotify_anchored_at
            from tracks where track_id = ?`,
    });

    return result.rows[0];
  }

  it("stamps a publish-born finding with `publish` and its finding's added_at", async () => {
    await insertPublishBorn("abcdefghij0123456789AB", "2026-03-04T10:00:00.000Z");

    const result = await backfillIdentityLedger(db, "2026-07-29T00:00:00.000Z");

    expect(result.publishAnchorsStamped).toBe(1);

    const after = await provenance("abcdefghij0123456789AB");

    expect(after?.spotify_anchor_source).toBe("publish");
    expect(after?.spotify_anchor_verified_by).toBe("publish");

    expect(after?.spotify_anchored_at).toBe("2026-03-04T10:00:00.000Z");
  });

  it("CANNOT mislabel the row shapes that sit next to it", async () => {
    await db.execute({
      args: [],
      sql: `insert into tracks (track_id, title, artists_json, duration_ms, spotify_uri, spotify_url, is_catalogue)
            values ('mb_crawled', 'Tune', '["Artist"]', 300000, 'spotify:track:zzzzzzzzzzzzzzzzzzzzzz',
                    'https://open.spotify.com/track/zzzzzzzzzzzzzzzzzzzzzz', 0)`,
    });
    await db.execute({
      args: [],
      sql: `insert into findings (track_id, log_id, added_at) values ('mb_crawled', '005.1.1A', '2026-04-01T00:00:00.000Z')`,
    });

    await db.execute({
      args: [],
      sql: `insert into tracks (track_id, title, artists_json, duration_ms, spotify_uri, spotify_url)
            values ('sp_qqqqqqqqqqqqqqqqqqqqqq', 'Tune', '["Artist"]', 300000,
                    'spotify:track:qqqqqqqqqqqqqqqqqqqqqq', 'https://open.spotify.com/track/qqqqqqqqqqqqqqqqqqqqqq')`,
    });

    await db.execute({
      args: [],
      sql: `insert into tracks (track_id, title, artists_json, duration_ms, spotify_uri, spotify_url)
            values ('wwwwwwwwwwwwwwwwwwwwww', 'Tune', '["Artist"]', 300000,
                    'spotify:track:wwwwwwwwwwwwwwwwwwwwww', 'https://open.spotify.com/track/wwwwwwwwwwwwwwwwwwwwww')`,
    });

    const result = await backfillIdentityLedger(db, "2026-07-29T00:00:00.000Z");

    expect(result.publishAnchorsStamped).toBe(0);

    for (const trackId of ["mb_crawled", "sp_qqqqqqqqqqqqqqqqqqqqqq", "wwwwwwwwwwwwwwwwwwwwww"]) {
      const after = await provenance(trackId);

      expect(after?.spotify_anchor_source, trackId).toBeNull();
      expect(after?.spotify_anchor_verified_by, trackId).toBeNull();
    }
  });

  it("never overwrites provenance a real write has since recorded, and re-runs as a no-op", async () => {
    await insertPublishBorn("ccccccccccccccccccccc1", "2026-03-04T10:00:00.000Z");
    await db.execute({
      args: [],
      sql: `update tracks
            set spotify_anchor_source = 'apify', spotify_anchor_verified_by = 'search',
                spotify_anchored_at = '2026-05-05T00:00:00.000Z'
            where track_id = 'ccccccccccccccccccccc1'`,
    });

    const first = await backfillIdentityLedger(db, "2026-07-29T00:00:00.000Z");

    expect(first.publishAnchorsStamped).toBe(0);
    expect((await provenance("ccccccccccccccccccccc1"))?.spotify_anchor_verified_by).toBe("search");

    await insertPublishBorn("dddddddddddddddddddddd", "2026-03-05T10:00:00.000Z", "006.2.2B");
    expect(
      (await backfillIdentityLedger(db, "2026-07-29T00:00:00.000Z")).publishAnchorsStamped,
    ).toBe(1);
    expect(
      (await backfillIdentityLedger(db, "2026-07-30T00:00:00.000Z")).publishAnchorsStamped,
    ).toBe(0);
    expect((await provenance("dddddddddddddddddddddd"))?.spotify_anchored_at).toBe(
      "2026-03-05T10:00:00.000Z",
    );
  });
});
