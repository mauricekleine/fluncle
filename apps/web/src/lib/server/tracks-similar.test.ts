import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backfillEmbeddingBlob } from "../../../scripts/backfill-embedding-blob";
import { cosineSimilarity, EMBEDDING_DIMS, parseEmbedding, rankBySimilarity } from "./embedding";
import { createIntegrationDb, seedTrack } from "./integration-db";
import { getSimilarFindings } from "./tracks";

// The DB-backed "more like this" reader (docs/track-lifecycle.md) — the data source for
// the public `get_similar_findings` op AND the `/log` row.
//
// THIS SUITE RUNS AGAINST REAL libSQL, not a mocked `execute`. It has to: the ranking now
// happens IN SQL (`vector_distance_cos` over an `F32_BLOB(1024)`, the probe bound as raw
// bytes — lib/server/embedding.ts), so a hand-rolled mock would only ever be testing the
// mock. The in-memory client applies the real generated migrations, and the real libSQL
// vector functions are what answer.
//
// THE PIN (the last test) is the one that matters most: over a 40-finding pseudo-random
// corpus it asserts the SQL ranking returns the SAME findings in the SAME order as the
// OLD in-isolate path (`parseEmbedding` + `cosineSimilarity` + `rankBySimilarity`, still
// exported and used here as the reference implementation). Same results, 21 KB/row less.

const execute = vi.hoisted(() => vi.fn());
let db: Client;

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRow: <T extends object>(rows: T[]) => rows[0],
  typedRows: <T extends object>(rows: T[]) => rows,
}));

/** A 1024-d vector pointing in the (a, b) direction (the rest zero) — a valid MuQ shape. */
function vector(a: number, b: number): number[] {
  const values = Array.from({ length: EMBEDDING_DIMS }, () => 0);
  values[0] = a;
  values[1] = b;

  return values;
}

/**
 * A deterministic pseudo-random unit-ish vector — the pin's corpus. Real MuQ vectors are
 * dense and L2-normalized; a corpus of axis-aligned toys would let a broken ranking pass.
 */
function pseudoVector(seed: number): number[] {
  let state = seed * 2654435761;
  const values: number[] = [];

  for (let index = 0; index < EMBEDDING_DIMS; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    values.push(state / 0x3fffffff - 1);
  }

  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));

  return values.map((value) => value / norm);
}

type Seed = {
  /** Written to `embedding_json` verbatim — a raw string so a MALFORMED vector can be seeded. */
  embeddingJson?: string | null;
  logId: string | null;
  title?: string;
  trackId: string;
};

async function seed(rows: Seed[]): Promise<void> {
  for (const row of rows) {
    await seedTrack(db, {
      logId: row.logId ?? null,
      title: row.title ?? "Test Track",
      trackId: row.trackId,
    });
    await db.execute({
      args: [row.embeddingJson ?? null, `https://img/${row.trackId}.jpg`, row.trackId],
      sql: `update tracks set embedding_json = ?, album_image_url = ? where track_id = ?`,
    });
  }
}

/** A libSQL text cell, narrowed (the driver types every cell as a union). */
function textCell(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The reference ranking: the OLD in-isolate path, kept as the pin's oracle. */
async function rankInIsolate(targetId: string, limit: number): Promise<string[]> {
  const rows = await db.execute({
    args: [targetId],
    sql: `select tracks.track_id, tracks.embedding_json
          from findings join tracks on tracks.track_id = findings.track_id
          where findings.log_id is not null
            and tracks.embedding_json is not null
            and tracks.track_id != ?`,
  });
  const target = await db.execute({
    args: [targetId],
    sql: `select embedding_json from tracks where track_id = ?`,
  });
  const targetVector = parseEmbedding(textCell(target.rows[0]?.embedding_json));

  if (!targetVector) {
    return [];
  }

  const candidates = rows.rows.flatMap((row) => {
    const embedding = parseEmbedding(textCell(row.embedding_json));
    const trackId = textCell(row.track_id);

    return embedding && trackId ? [{ embedding, item: trackId }] : [];
  });

  return rankBySimilarity(targetVector, candidates, limit);
}

beforeEach(async () => {
  db = await createIntegrationDb();
  execute.mockReset();
  // `getDb()` hands the REAL in-memory client's `execute` to the code under test.
  execute.mockImplementation((query: unknown) => db.execute(query as never));
});

describe("getSimilarFindings", () => {
  // Self (the target), three neighbours in decreasing similarity, and three vectors that
  // are stored but UNREADABLE — each of which would make `vector32()` throw if it ever
  // reached it, which is what `embeddingVectorSql`'s guard exists to prevent.
  const CORPUS: Seed[] = [
    { embeddingJson: JSON.stringify(vector(1, 0)), logId: "004.0.0A", trackId: "t_self" },
    {
      embeddingJson: JSON.stringify(vector(1, 0)),
      logId: "004.1.1A",
      title: "Identical",
      trackId: "t_ident",
    },
    {
      embeddingJson: JSON.stringify(vector(1, 1)),
      logId: "004.2.2B",
      title: "Diagonal",
      trackId: "t_diag",
    },
    {
      embeddingJson: JSON.stringify(vector(0, 1)),
      logId: "004.3.3C",
      title: "Orthogonal",
      trackId: "t_orth",
    },
    { embeddingJson: "[1,2,3]", logId: "004.4.4D", trackId: "t_short" }, // wrong width
    { embeddingJson: "not json at all", logId: "004.5.5E", trackId: "t_garbage" }, // unparseable
    {
      // Right width, WRONG element type — the one that `json_valid` + a length check alone
      // would wave through, and that `vector32()` throws on.
      embeddingJson: JSON.stringify(Array.from({ length: EMBEDDING_DIMS }, () => "x")),
      logId: "004.6.6F",
      trackId: "t_strings",
    },
  ];

  it("returns the coordinate-bearing neighbours in descending sonic similarity", async () => {
    await seed(CORPUS);
    await backfillEmbeddingBlob(db);

    const findings = await getSimilarFindings("t_self");

    // identical (cos 1) > diagonal (~0.707) > orthogonal (0). The three unreadable rows are
    // dropped, and `t_self` never appears (the self-exclusion predicate).
    expect(findings.map((finding) => finding.trackId)).toEqual(["t_ident", "t_diag", "t_orth"]);
  });

  it("resolves the target by Log ID as well as by track id", async () => {
    await seed(CORPUS);
    await backfillEmbeddingBlob(db);

    const findings = await getSimilarFindings("004.0.0A");

    expect(findings.map((finding) => finding.trackId)).toEqual(["t_ident", "t_diag", "t_orth"]);
  });

  it("maps each neighbour to the row's display fields (cover, coordinate, identity)", async () => {
    await seed(CORPUS);
    await backfillEmbeddingBlob(db);

    const [first] = await getSimilarFindings("t_self");

    expect(first).toMatchObject({
      albumImageUrl: "https://img/t_ident.jpg",
      logId: "004.1.1A",
      title: "Identical",
      trackId: "t_ident",
    });
  });

  it("honours the limit (the top-N)", async () => {
    await seed(CORPUS);
    await backfillEmbeddingBlob(db);

    const findings = await getSimilarFindings("t_self", 2);

    expect(findings.map((finding) => finding.trackId)).toEqual(["t_ident", "t_diag"]);
  });

  it("ranks a finding the backfill has not reached yet, from its JSON", async () => {
    // The zero-downtime case: a row embedded by the PREVIOUS Worker between the deploy's
    // backfill and its cutover has `embedding_json` but no blob. It must still rank.
    await seed(CORPUS);
    await backfillEmbeddingBlob(db);
    await db.execute(`update tracks set embedding_blob = null where track_id = 't_diag'`);

    const findings = await getSimilarFindings("t_self");

    expect(findings.map((finding) => finding.trackId)).toEqual(["t_ident", "t_diag", "t_orth"]);
  });

  it("survives an unreadable stored vector rather than throwing", async () => {
    // Nothing is backfilled, so EVERY row takes the JSON arm — including the three that
    // would make `vector32()` throw and abort the whole query.
    await seed(CORPUS);

    const findings = await getSimilarFindings("t_self");

    expect(findings.map((finding) => finding.trackId)).toEqual(["t_ident", "t_diag", "t_orth"]);
  });

  it("excludes a finding with no coordinate (nothing to link to)", async () => {
    await seed([
      ...CORPUS,
      { embeddingJson: JSON.stringify(vector(1, 0)), logId: null, trackId: "t_uncharted" },
    ]);
    await backfillEmbeddingBlob(db);

    const findings = await getSimilarFindings("t_self");

    expect(findings.map((finding) => finding.trackId)).not.toContain("t_uncharted");
  });

  it("returns [] for a non-positive limit without touching the DB", async () => {
    await seed(CORPUS);
    execute.mockClear();

    expect(await getSimilarFindings("t_self", 0)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns [] for an unknown finding", async () => {
    await seed(CORPUS);

    expect(await getSimilarFindings("nope")).toEqual([]);
  });

  it("returns [] when the finding has no embedding yet (the embed cron hasn't drained it)", async () => {
    await seed([{ embeddingJson: null, logId: "004.9.9Z", trackId: "t_bare" }, ...CORPUS]);
    await backfillEmbeddingBlob(db);

    expect(await getSimilarFindings("t_bare")).toEqual([]);
  });

  it("returns [] when nothing else is embedded", async () => {
    await seed([
      { embeddingJson: JSON.stringify(vector(1, 0)), logId: "004.0.0A", trackId: "t_self" },
      { embeddingJson: null, logId: "004.1.1A", trackId: "t_other" },
    ]);
    await backfillEmbeddingBlob(db);

    expect(await getSimilarFindings("t_self")).toEqual([]);
  });

  // ── THE PIN ────────────────────────────────────────────────────────────────
  it("returns exactly what the old in-isolate ranking returned (same findings, same order)", async () => {
    const corpus: Seed[] = Array.from({ length: 40 }, (_, index) => ({
      embeddingJson: JSON.stringify(pseudoVector(index + 1)),
      logId: `00${index % 9}.${index}.1A`,
      trackId: `t_${String(index).padStart(2, "0")}`,
    }));

    await seed(corpus);
    await backfillEmbeddingBlob(db);

    for (const limit of [1, 6, 12]) {
      const fromSql = (await getSimilarFindings("t_00", limit)).map((finding) => finding.trackId);
      const fromIsolate = await rankInIsolate("t_00", limit);

      expect(fromSql).toEqual(fromIsolate);
      expect(fromSql).toHaveLength(limit);
    }

    // …and the ordering it produces is a genuine descending-cosine order, not an accident
    // of insertion (the guard against a silently-empty or reversed SQL ranking).
    const target = pseudoVector(1);
    const ranked = await getSimilarFindings("t_00", 6);
    const cosines = ranked.map((finding) =>
      cosineSimilarity(target, pseudoVector(Number(finding.trackId.slice(2)) + 1)),
    );

    expect(cosines).toEqual([...cosines].sort((a, b) => b - a));
  });
});
