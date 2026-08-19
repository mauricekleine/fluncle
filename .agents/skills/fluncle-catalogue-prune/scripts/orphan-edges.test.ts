import { describe, expect, test } from "bun:test";

import { type Client } from "@libsql/client/web";

import { countOrphanEdges, deleteOrphanEdges, orphanEdgesByArtist } from "./clean-orphan-edges";
import {
  ORPHAN_EDGE_BY_ARTIST_SQL,
  ORPHAN_EDGE_COUNT_SQL,
  ORPHAN_EDGE_DELETE_SQL,
  deleteTracksWithEdges,
  orphanEdgeWhere,
} from "./lib";

// The prune scripts talk to PRODUCTION, so nothing here may touch a real database. These tests
// drive a recording stub of the libSQL `Client` and assert the two things that actually decide
// whether an edge can be stranded: the ORDER + ATOMICITY of the purge's delete pair, and the
// orphan predicate the cleanup command scans and deletes by.

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
  test("deletes the edges, the vectors and the tracks in ONE batch, dependants first, over the same id set", async () => {
    const s = stub();
    await deleteTracksWithEdges(s.client, ["t1", "t2"]);

    expect(s.batches).toHaveLength(1);
    const [batch] = s.batches;
    expect(batch?.mode).toBe("write");
    expect(batch?.stmts).toHaveLength(3);
    // Dependants FIRST — there must never be a window where the track is gone and a row keyed on
    // it remains. The vector's own `on delete cascade` would cover it when `PRAGMA foreign_keys`
    // is on; this delete is what makes it true either way.
    expect(batch?.stmts[0]?.sql).toBe("delete from track_artists where track_id in (?,?)");
    expect(batch?.stmts[1]?.sql).toBe("delete from track_embeddings where track_id in (?,?)");
    expect(batch?.stmts[2]?.sql).toBe("delete from tracks where track_id in (?,?)");
    // Same id set, bound as args (never interpolated).
    expect(batch?.stmts[0]?.args).toEqual(["t1", "t2"]);
    expect(batch?.stmts[1]?.args).toEqual(["t1", "t2"]);
    expect(batch?.stmts[2]?.args).toEqual(["t1", "t2"]);
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
    expect(s.batches[0]?.stmts).toHaveLength(3);
    expect(s.batches[1]?.stmts).toHaveLength(3);
    expect(s.batches[0]?.stmts[0]?.args).toHaveLength(200);
    expect(s.batches[1]?.stmts[0]?.args).toHaveLength(50);
    // Each chunk deletes the edges, the vectors and the tracks for the SAME ids.
    expect(s.batches[1]?.stmts[0]?.args).toEqual(s.batches[1]?.stmts[1]?.args);
    expect(s.batches[1]?.stmts[0]?.args).toEqual(s.batches[1]?.stmts[2]?.args);
  });

  test("reports the rows removed from each table", async () => {
    const s = stub();
    const removed = await deleteTracksWithEdges(s.client, ["t1"]);

    // The stub returns `(index + 1) * 10` per statement, so the counts must be read off the
    // RIGHT statements: edges is the first, tracks the third (the vector delete is unreported —
    // it is a cascade, not a number the operator is deciding anything from).
    expect(removed).toEqual({ edges: 10, tracks: 30 });
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
