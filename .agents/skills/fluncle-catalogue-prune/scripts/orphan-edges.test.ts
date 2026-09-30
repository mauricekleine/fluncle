import { describe, expect, test } from "bun:test";

import { type Client } from "@libsql/client/web";

import { repairPublicProjectionChunk } from "../../../../apps/web/src/lib/server/public-projections";
import { createProjectionTestDb } from "../../../../apps/web/src/test/projection-schema";

import { countOrphanEdges, deleteOrphanEdges, orphanEdgesByArtist } from "./clean-orphan-edges";
import {
  ORPHAN_EDGE_BY_ARTIST_SQL,
  ORPHAN_EDGE_COUNT_SQL,
  ORPHAN_EDGE_DELETE_SQL,
  deleteTracksWithEdges,
  orphanEdgeWhere,
} from "./lib";

type Statement = { args?: unknown; sql: string };

type Stub = {
  batches: { mode?: string; stmts: Statement[] }[];
  client: Client;
  executed: string[];
};

function stub(rows: Record<string, unknown>[] = [], rowsAffected = 0): Stub {
  const batches: Stub["batches"] = [];
  const executed: string[] = [];
  const client = {
    batch: async (stmts: Statement[], mode?: string) => {
      batches.push({ mode, stmts });

      return stmts.map((_, i) => ({ rows: [], rowsAffected: (i + 1) * 10 }));
    },
    execute: async (stmt: Statement | string) => {
      executed.push(typeof stmt === "string" ? stmt : stmt.sql);

      return { rows, rowsAffected };
    },
  };

  return { batches, client: client as unknown as Client, executed };
}

describe("deleteTracksWithEdges", () => {
  test("pruned tracks repair both projections and advance the public order epoch", async () => {
    const db = await createProjectionTestDb();
    await db.executeMultiple(`
      create table track_embeddings (track_id text primary key);
      insert into tracks (track_id) values ('pruned');
      insert into track_artists (track_id, artist_id) values ('pruned', 'artist');
      insert into due_work (work_kind, subject_type, subject_id, state)
        values ('capture-catalogue', 'track', 'pruned', 'ready');
      insert into public_aggregate_state
        (scope, state, scanned_count, projected_entry_count, source_epoch, aggregate_epoch,
         default_track_total, release_hub_order_epoch, generation)
        values ('tracks', 'complete', 0, 0, 0, 0, 1, 0, 'generation');
      insert into public_aggregate_membership
        (track_id, source_version) values ('pruned', '[null,null]');
      insert into artist_qualification_state
        (scope, state, scanned_count, projected_qualified_count, source_epoch, projection_epoch)
        values ('artists', 'complete', 0, 0, 0, 0);
    `);

    expect(await deleteTracksWithEdges(db as unknown as Client, ["pruned"])).toEqual({
      edges: 1,
      tracks: 1,
    });
    expect((await db.execute(`select track_id from tracks`)).rows).toHaveLength(0);
    expect((await db.execute(`select subject_id from due_work`)).rows).toHaveLength(0);
    expect(
      (await db.execute(`select source_epoch from public_aggregate_state`)).rows[0]?.source_epoch,
    ).toBe(1);
    expect(
      (await db.execute(`select source_epoch from artist_qualification_state`)).rows[0]
        ?.source_epoch,
    ).toBe(1);
    expect(
      (
        await db.execute(`select projection, subject_id from projection_repairs
      order by projection`)
      ).rows.map((row) => [row.projection, row.subject_id]),
    ).toEqual([
      ["artist_qualification", "pruned"],
      ["public_aggregates", "pruned"],
    ]);
    await repairPublicProjectionChunk(db, { projection: "public_aggregates" });
    expect(
      (
        await db.execute(`select default_track_total, release_hub_order_epoch
        from public_aggregate_state`)
      ).rows[0],
    ).toMatchObject({ default_track_total: 0, release_hub_order_epoch: 1 });
    db.close();
  });

  test("deletes the edges, the vectors and the tracks in ONE batch, dependants first, over the same id set", async () => {
    const s = stub();
    await deleteTracksWithEdges(s.client, ["t1", "t2"]);

    expect(s.batches).toHaveLength(1);
    const [batch] = s.batches;
    expect(batch?.mode).toBe("write");
    expect(batch?.stmts).toHaveLength(8);

    expect(batch?.stmts[0]?.sql).toBe("delete from track_artists where track_id in (?,?)");
    expect(batch?.stmts[1]?.sql).toBe("delete from track_embeddings where track_id in (?,?)");
    expect(batch?.stmts[2]?.sql).toBe(
      "delete from due_work where subject_type = 'track' and subject_id in (?,?)",
    );
    expect(batch?.stmts[3]?.sql).toBe("delete from tracks where track_id in (?,?)");

    expect(batch?.stmts[0]?.args).toEqual(["t1", "t2"]);
    expect(batch?.stmts[1]?.args).toEqual(["t1", "t2"]);
    expect(batch?.stmts[2]?.args).toEqual(["t1", "t2"]);
    expect(batch?.stmts[3]?.args).toEqual(["t1", "t2"]);
  });

  test("never issues a bare execute — the pair is always transactional", async () => {
    const s = stub();
    await deleteTracksWithEdges(s.client, ["t1"]);

    expect(s.executed).toEqual([]);
  });

  test("chunks past the SQLite IN() limit, keeping every chunk's pair atomic", async () => {
    const s = stub();
    const ids = Array.from({ length: 250 }, (_, i) => `t${i}`);
    await deleteTracksWithEdges(s.client, ids);

    expect(s.batches).toHaveLength(2);
    expect(s.batches[0]?.stmts).toHaveLength(8);
    expect(s.batches[1]?.stmts).toHaveLength(8);
    expect(s.batches[0]?.stmts[0]?.args).toHaveLength(200);
    expect(s.batches[1]?.stmts[0]?.args).toHaveLength(50);

    expect(s.batches[1]?.stmts[0]?.args).toEqual(s.batches[1]?.stmts[1]?.args);
    expect(s.batches[1]?.stmts[0]?.args).toEqual(s.batches[1]?.stmts[2]?.args);
    expect(s.batches[1]?.stmts[0]?.args).toEqual(s.batches[1]?.stmts[3]?.args);
  });

  test("reports the rows removed from each table", async () => {
    const s = stub();
    const removed = await deleteTracksWithEdges(s.client, ["t1"]);

    expect(removed).toEqual({ edges: 10, tracks: 40 });
  });

  test("an empty id set touches nothing", async () => {
    const s = stub();
    const removed = await deleteTracksWithEdges(s.client, []);

    expect(s.batches).toEqual([]);
    expect(removed).toEqual({ edges: 0, tracks: 0 });
  });
});

describe("the orphan predicate", () => {
  test("is a not-exists probe against `tracks`, keyed by the edge's track_id", () => {
    expect(orphanEdgeWhere("ta")).toBe(
      "not exists (select 1 from tracks t where t.track_id = ta.track_id)",
    );
  });

  test("the scan and the delete share ONE predicate, so they can never disagree", () => {
    expect(ORPHAN_EDGE_COUNT_SQL).toContain(orphanEdgeWhere("ta"));
    expect(ORPHAN_EDGE_BY_ARTIST_SQL).toContain(orphanEdgeWhere("ta"));
    expect(ORPHAN_EDGE_DELETE_SQL).toContain(orphanEdgeWhere("track_artists"));
  });

  test("the delete is unaliased — `delete from <table> as <alias>` is not portable", () => {
    expect(ORPHAN_EDGE_DELETE_SQL.startsWith("delete from track_artists where ")).toBe(true);
  });

  test("the scan groups by artist and left-joins, so an edge whose artist is gone still shows", () => {
    expect(ORPHAN_EDGE_BY_ARTIST_SQL).toContain("left join artists a on a.id = ta.artist_id");
    expect(ORPHAN_EDGE_BY_ARTIST_SQL).toContain("group by ta.artist_id");
  });
});

describe("the cleanup command's reads", () => {
  test("countOrphanEdges returns the scalar", async () => {
    const s = stub([{ n: 62 }]);

    expect(await countOrphanEdges(s.client)).toBe(62);
    expect(s.executed).toEqual([ORPHAN_EDGE_COUNT_SQL]);
  });

  test("countOrphanEdges reads a clean database as zero", async () => {
    expect(await countOrphanEdges(stub([]).client)).toBe(0);
  });

  test("orphanEdgesByArtist shapes the per-artist breakdown", async () => {
    const s = stub([{ artist_id: "a1", edges: 4, name: "Someone", slug: "someone" }]);

    expect(await orphanEdgesByArtist(s.client)).toEqual([
      { artist_id: "a1", edges: 4, name: "Someone", slug: "someone" },
    ]);
  });

  test("deleteOrphanEdges reports rowsAffected", async () => {
    const s = stub([], 62);

    expect(await deleteOrphanEdges(s.client)).toBe(62);
    expect(s.executed).toEqual([ORPHAN_EDGE_DELETE_SQL]);
  });
});
