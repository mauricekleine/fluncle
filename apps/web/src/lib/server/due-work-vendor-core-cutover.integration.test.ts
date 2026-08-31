import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveArtistCredits } from "./backfill-artist-credits";
import { resolveArtistEdges } from "./backfill-artist-edges";
import {
  CATALOGUE_RANK_STATE_KEY,
  countUnverifiedCaptures,
  listUnverifiedCaptures,
  rankCatalogue,
} from "./catalogue";
import { TRACK_WORK_DUE_CUTOVER_ENABLED_KEY } from "./due-work-cutover";
import { encodeDueWorkOrder } from "./due-work-order";
import {
  DUE_WORK_SOURCE_REPAIR_KIND,
  DueWorkMaintenancePendingError,
  upsertDueWork,
} from "./due-work";
import { createIntegrationDb, seedArtist, seedCatalogueTrack } from "./integration-db";
import { resolveRecordingMbids } from "./recording-mbids";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./musicbrainz", () => ({ mbFetch: vi.fn() }));

const PAST = "2020-01-01T00:00:00.000Z";

async function enableCutover(): Promise<void> {
  await db.execute({
    args: [TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true"],
    sql: `insert into settings (key, value) values (?, ?)`,
  });
}

async function schedule(workKind: string, subjectId: string, sortKey?: string): Promise<void> {
  await upsertDueWork(db, {
    nextDueAt: PAST,
    sortKey: sortKey ?? encodeDueWorkOrder([{ direction: "asc", kind: "text", value: subjectId }]),
    sourceVersion: `test-${workKind}-${subjectId}`,
    state: "scheduled",
    subjectId,
    subjectType: "track",
    workKind,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

afterEach(() => {
  db.close();
});

describe("Goal C core vendor selector cutovers", () => {
  it("keeps capture verification legacy-compatible while unset and hydrates only promoted IDs", async () => {
    for (const trackId of ["cap_a", "cap_b", "cap_c"]) {
      await seedCatalogueTrack(db, { trackId });
      await db.execute({
        args: [`catalogue/${trackId}/audio.webm`, trackId],
        sql: `update tracks set source_audio_key = ? where track_id = ?`,
      });
    }

    expect((await listUnverifiedCaptures(2)).map((row) => row.trackId)).toEqual(["cap_a", "cap_b"]);

    await enableCutover();
    await schedule("capture-verification", "cap_a");
    await schedule("capture-verification", "cap_b");
    expect(await countUnverifiedCaptures()).toBe(2);
    await schedule("capture-verification", "00_missing");

    // The missing projected subject consumes its projection slot; hydration cannot leak cap_b in
    // from the source corpus to fill the hole.
    expect((await listUnverifiedCaptures(2)).map((row) => row.trackId)).toEqual(["cap_a"]);
    const promoted = await db.execute({
      args: ["capture-verification"],
      sql: `select count(*) as n from due_work where work_kind = ? and state = 'ready'`,
    });
    expect(Number(promoted.rows[0]?.n ?? 0)).toBeGreaterThan(0);
  });

  it("uses projection cursors for MBID work and opens refresh only after an empty first page", async () => {
    await seedCatalogueTrack(db, { trackId: "mb_prefix" });
    await seedCatalogueTrack(db, { trackId: "lookup_a" });
    await seedCatalogueTrack(db, { trackId: "lookup_b" });
    await seedCatalogueTrack(db, { trackId: "refresh_a" });
    await db.execute({
      args: ["ISRC-A", "lookup_a"],
      sql: `update tracks set isrc = ? where track_id = ?`,
    });
    await db.execute({
      args: ["ISRC-B", "lookup_b"],
      sql: `update tracks set isrc = ? where track_id = ?`,
    });
    await db.execute({
      args: ["recording-a", "refresh_a"],
      sql: `update tracks set mb_recording_id = ? where track_id = ?`,
    });
    await enableCutover();
    await schedule("mbid-prefix-strip", "mb_prefix");
    await schedule("mbid-isrc-lookup", "lookup_a");
    await schedule("mbid-isrc-lookup", "lookup_b");
    await schedule("mbid-isrc-refresh", "refresh_a", "refresh-a");

    const first = await resolveRecordingMbids(1, true);
    expect(first.prefixStripped).toBe(1);
    expect(first.resolved).toEqual(["lookup_a"]);
    expect(first.isrcRefreshed).toEqual([]);

    const continued = await resolveRecordingMbids(1, true, "lookup_a");
    expect(continued.prefixStripped).toBe(0);
    expect(continued.resolved).toEqual(["lookup_b"]);
    expect(continued.isrcRefreshed).toEqual([]);

    await db.execute({
      args: ["mbid-isrc-lookup"],
      sql: `delete from due_work where work_kind = ?`,
    });
    const idle = await resolveRecordingMbids(1, true);
    expect(idle.resolved).toEqual([]);
    expect(idle.isrcRefreshed).toEqual(["refresh_a"]);
  });

  it("re-checks projected prefix subjects so stale rows are neither counted nor overwritten", async () => {
    await seedCatalogueTrack(db, { trackId: "mb_stale" });
    await db.execute({
      args: ["already-resolved", "mb_stale"],
      sql: `update tracks set mb_recording_id = ? where track_id = ?`,
    });
    await enableCutover();
    await schedule("mbid-prefix-strip", "mb_stale");

    expect((await resolveRecordingMbids(1, true, undefined, 0)).prefixStripped).toBe(0);
    expect((await resolveRecordingMbids(1, false, undefined, 0)).prefixStripped).toBe(0);

    const row = await db.execute({
      args: ["mb_stale"],
      sql: `select mb_recording_id from tracks where track_id = ?`,
    });
    expect(row.rows[0]?.mb_recording_id).toBe("already-resolved");
  });

  it("removes projected prefix work after converging the source mutation", async () => {
    await seedCatalogueTrack(db, { trackId: "mb_live" });
    await enableCutover();
    await schedule("mbid-prefix-strip", "mb_live");

    expect((await resolveRecordingMbids(1, false, undefined, 0)).prefixStripped).toBe(1);

    const result = await db.execute({
      args: ["mb_live", "mbid-prefix-strip", DUE_WORK_SOURCE_REPAIR_KIND],
      sql: `select work_kind, state from due_work where subject_id = ?
        and work_kind in (?, ?)`,
    });
    expect(result.rows).toEqual([]);
  });

  it("preserves artist-edge and artist-credit dry-run cursors from projection order", async () => {
    await seedArtist(db, { id: "artist-logistics", name: "Logistics", slug: "logistics" });
    await seedCatalogueTrack(db, { artists: ["Logistics"], trackId: "edge_a" });
    await seedCatalogueTrack(db, { artists: ["Logistics"], trackId: "edge_b" });
    await seedCatalogueTrack(db, { trackId: "credit_a" });
    await db.execute({
      args: [PAST, "credit_a"],
      sql: `update tracks set artist_edges_backfilled_at = ? where track_id = ?`,
    });
    await enableCutover();
    await schedule("artist-edges", "edge_a");
    await schedule("artist-edges", "edge_b");
    await schedule("artist-credits", "credit_a");

    const edges = await resolveArtistEdges(1, true);
    expect(edges.fullyMatched).toEqual(["edge_a"]);
    expect(edges.nextCursor).toBe("edge_a");
    const continuedEdges = await resolveArtistEdges(1, true, "edge_a");
    expect(continuedEdges.fullyMatched).toEqual(["edge_b"]);

    const credits = await resolveArtistCredits(1, true);
    expect(credits.scanned).toBe(1);
    expect(credits.nextCursor).toBe("credit_a");
  });

  it("ranks only promoted catalogue subjects and uses the projection has-more sentinel", async () => {
    await seedCatalogueTrack(db, { trackId: "rank_a" });
    await seedCatalogueTrack(db, { trackId: "rank_b" });
    await enableCutover();
    await schedule("catalogue-rank", "rank_a");
    await schedule("catalogue-rank", "rank_b");

    const summary = await rankCatalogue(1);
    expect(summary.prioritized).toBe(1);
    expect(summary.remaining).toBeGreaterThan(0);

    const rows = await db.execute({
      args: ["rank_a", "rank_b"],
      sql: `select track_id, catalogue_rank_corpus from tracks
            where track_id in (?, ?) order by track_id`,
    });
    expect(rows.rows.map((row) => [row.track_id, row.catalogue_rank_corpus])).toEqual([
      ["rank_a", summary.corpus],
      ["rank_b", null],
    ]);
  });

  it("proves an empty projected rank tick never reads the growing source corpus", async () => {
    const state = { corpus: "v5:0:0:0:cached", embeddedFindings: 0, findings: 0 };
    await enableCutover();
    await db.execute({
      args: [CATALOGUE_RANK_STATE_KEY, JSON.stringify(state)],
      sql: `insert into settings (key, value) values (?, ?)`,
    });
    const execute = vi.spyOn(db, "execute");

    expect(await rankCatalogue()).toMatchObject({ ...state, remaining: 0 });

    const statements = execute.mock.calls.map((call) => {
      const input = call[0] as string | { sql: string };
      return typeof input === "string" ? input : input.sql;
    });
    expect(statements.some((sql) => /\b(?:from|join)\s+(?:tracks|findings)\b/i.test(sql))).toBe(
      false,
    );
  });

  it.each([undefined, "not-json"])(
    "refuses an empty projected rank tick with an unready cache (%s) without scanning sources",
    async (cache) => {
      await enableCutover();
      if (cache !== undefined) {
        await db.execute({
          args: [CATALOGUE_RANK_STATE_KEY, cache],
          sql: `insert into settings (key, value) values (?, ?)`,
        });
      }
      const execute = vi.spyOn(db, "execute");

      await expect(rankCatalogue()).rejects.toBeInstanceOf(DueWorkMaintenancePendingError);

      const statements = execute.mock.calls.map((call) => {
        const input = call[0] as string | { sql: string };
        return typeof input === "string" ? input : input.sql;
      });
      expect(statements.some((sql) => /\b(?:from|join)\s+(?:tracks|findings)\b/i.test(sql))).toBe(
        false,
      );
    },
  );
});
