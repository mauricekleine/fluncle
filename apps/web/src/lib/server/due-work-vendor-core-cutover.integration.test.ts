import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveArtistCredits } from "./backfill-artist-credits";
import { resolveArtistEdges } from "./backfill-artist-edges";
import {
  CATALOGUE_RANK_STATE_KEY,
  catalogueRankCorpusForTrack,
  countUnverifiedCaptures,
  listUnverifiedCaptures,
  rankCatalogue,
} from "./catalogue";
import { TRACK_WORK_DUE_CUTOVER_ENABLED_KEY } from "./due-work-cutover";
import { encodeDueWorkOrder } from "./due-work-order";
import {
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  DUE_WORK_SOURCE_REPAIR_KIND,
  DueWorkMaintenancePendingError,
  markDueWorkRepair,
  markDueWorkSourceRepairsStatement,
  upsertDueWork,
} from "./due-work";
import {
  DUE_WORK_READ_DRAIN_BUDGET,
  hasPendingTrackSourceMarkers,
  SOURCE_REPAIR_LIMIT,
} from "./due-work-source-repair";
import {
  createIntegrationDb,
  seedArtist,
  seedCatalogueTrack,
  seedConvergedDueWorkRebuilds,
} from "./integration-db";
import { advanceProjectionFor } from "./projection-operations";
import { resolveRecordingMbids } from "./recording-mbids";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./musicbrainz", () => ({
  MB_USER_AGENT: "Fluncle test suite",
  mbFetch: vi.fn(),
  setMusicbrainzRateLimitForTests: vi.fn(),
}));

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
  await seedConvergedDueWorkRebuilds(db);
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
      ["rank_a", catalogueRankCorpusForTrack(summary.corpus, false)],
      ["rank_b", null],
    ]);
  });

  it("serves the rows a rank page's own residual fanout cannot touch", async () => {
    // One marker more than a guarded read's drain budget converges, so a marker survives the read.
    const pageSize = SOURCE_REPAIR_LIMIT * DUE_WORK_READ_DRAIN_BUDGET.sourcePages + 1;
    const trackIds = Array.from(
      { length: pageSize * 2 + 1 },
      (_, index) => `rank_page_${String(index).padStart(3, "0")}`,
    );
    for (const trackId of trackIds) {
      await seedCatalogueTrack(db, { trackId });
    }
    await enableCutover();
    for (const trackId of trackIds) {
      await schedule("catalogue-rank", trackId);
    }

    const first = await rankCatalogue(pageSize);
    expect(first.prioritized).toBe(pageSize);
    expect(first.remaining).toBeGreaterThan(0);

    // The page's own write-back left one marker per ranked subject. The next read's drain budget
    // converges every five-marker page it allows and still cannot reach the last one, which is the
    // shape that used to refuse the read outright. A marker owns its own subject and no other, so
    // the read serves a full page instead.
    const second = await rankCatalogue(pageSize);
    expect(second.prioritized).toBe(pageSize);
    expect(second.remaining).toBeGreaterThan(0);

    // Residual debt survives the read, which is what makes this the paused-tick shape.
    const pending = await db.execute({
      args: [DUE_WORK_SOURCE_REPAIR_KIND],
      sql: `select subject_id from due_work where work_kind = ? and state = 'repair'`,
    });
    expect(pending.rows).not.toHaveLength(0);

    const ranked = await db.execute(
      `select track_id from tracks where catalogue_rank_corpus is not null order by track_id`,
    );
    expect(ranked.rows.map((row) => row.track_id)).toEqual(trackIds.slice(0, pageSize * 2));
  });

  it("reads a rank page while unrelated repair debt keeps the shared track repair step incomplete", async () => {
    const trackIds = Array.from({ length: 6 }, (_, index) => `rank_unrelated_${index}`);
    for (const trackId of trackIds) {
      await seedCatalogueTrack(db, { trackId });
    }
    await enableCutover();
    for (const trackId of trackIds) {
      await schedule("catalogue-rank", trackId);
    }
    // Repair debt outside catalogue-rank's scope that no registered definition converges.
    await markDueWorkRepair(db, {
      sourceVersion: "unrelated-v1",
      subjectId: "artist_unrelated",
      subjectType: "artist",
      workKind: "unregistered-repair-debt",
    });

    const repair = await advanceProjectionFor(db, {
      action: "repair",
      includeStatus: false,
      limit: 500,
      target: "track_due_work",
    });
    expect(repair.complete).toBe(false);

    const ranked = await rankCatalogue(6);
    expect(ranked.prioritized).toBe(6);

    const unrelated = await db.execute({
      args: ["unregistered-repair-debt"],
      sql: `select state from due_work where work_kind = ?`,
    });
    expect(unrelated.rows.map((row) => row.state)).toEqual(["repair"]);
  });

  it("reports pending track source markers until a ranked page's fanout drains", async () => {
    // One marker more than a source page holds, so the first step provably leaves debt behind.
    const trackIds = Array.from(
      { length: SOURCE_REPAIR_LIMIT + 1 },
      (_, index) => `rank_drain_${String(index).padStart(3, "0")}`,
    );
    for (const trackId of trackIds) {
      await seedCatalogueTrack(db, { trackId });
    }
    await enableCutover();
    for (const trackId of trackIds) {
      await schedule("catalogue-rank", trackId);
    }
    expect((await rankCatalogue(trackIds.length)).prioritized).toBe(trackIds.length);

    const step = () =>
      advanceProjectionFor(db, {
        action: "repair",
        includeStatus: false,
        limit: 500,
        target: "track_due_work",
      });
    // One step fans out a full source page of the markers; the next clears the last one.
    expect(await step()).toMatchObject({ complete: false, trackSourceMarkersPending: true });
    expect(await step()).toMatchObject({ complete: true, trackSourceMarkersPending: false });
  });

  it("counts only ordinary track source markers as pending", async () => {
    expect(await hasPendingTrackSourceMarkers(db)).toBe(false);

    await db.execute(
      markDueWorkSourceRepairsStatement(
        [{ subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID, subjectType: "track" }],
        { markerVersion: "corpus-v1", producer: "catalogue-rank" },
      ),
    );
    await db.execute(
      markDueWorkSourceRepairsStatement([{ subjectId: "artist_marker", subjectType: "artist" }], {
        markerVersion: "artist-v1",
        producer: "catalogue-rank",
      }),
    );
    expect(await hasPendingTrackSourceMarkers(db)).toBe(false);

    await db.execute(
      markDueWorkSourceRepairsStatement([{ subjectId: "track_marker", subjectType: "track" }], {
        markerVersion: "track-v1",
        producer: "catalogue-rank",
      }),
    );
    expect(await hasPendingTrackSourceMarkers(db)).toBe(true);
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
