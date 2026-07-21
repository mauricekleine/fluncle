import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cosineSimilarity, EMBEDDING_DIMS, rankBySimilarity, readEmbeddingBlob } from "./embedding";
import { createIntegrationDb, seedTrack } from "./integration-db";
import { getSimilarFindings } from "./tracks";

// The DB-backed "more like this" reader (docs/track-lifecycle.md) — the data source for
// the public `list_similar_tracks` op AND the `/log` row.
//
// THIS SUITE RUNS AGAINST REAL libSQL, not a mocked `execute`. It has to: the ranking now
// happens IN SQL (`vector_distance_cos` over an `F32_BLOB(1024)`, the probe bound as raw
// bytes — lib/server/embedding.ts), so a hand-rolled mock would only ever be testing the
// mock. The in-memory client applies the real generated migrations, and the real libSQL
// vector functions are what answer.
//
// THE PIN (the last test) is the one that matters most: over a 40-finding pseudo-random
// corpus it asserts the SQL ranking returns the SAME findings in the SAME order as an
// independent in-isolate oracle (`readEmbeddingBlob` decodes the stored blob and
// `rankBySimilarity` cosines it in JS). Same results, computed two different ways.

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
  /** The MuQ vector to store as the ranked `embedding_blob`, or null for an un-embedded row. */
  embedding?: number[] | null;
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
    const embedding = row.embedding ?? null;
    await db.execute({
      // `vector32(NULL)` throws, so an un-embedded fixture writes a null blob explicitly.
      args: [
        embedding ? JSON.stringify(embedding) : null,
        `https://img/${row.trackId}.jpg`,
        row.trackId,
      ],
      sql: `update tracks
            set embedding_blob = case when ?1 is null then null else vector32(?1) end,
                album_image_url = ?2
            where track_id = ?3`,
    });
  }
}

/** The reference ranking: an independent in-isolate oracle that decodes the stored blob. */
async function rankInIsolate(targetId: string, limit: number): Promise<string[]> {
  const rows = await db.execute({
    args: [targetId],
    sql: `select tracks.track_id, tracks.embedding_blob
          from findings join tracks on tracks.track_id = findings.track_id
          where findings.log_id is not null
            and tracks.embedding_blob is not null
            and tracks.track_id != ?`,
  });
  const target = await db.execute({
    args: [targetId],
    sql: `select embedding_blob from tracks where track_id = ?`,
  });
  const targetVector = readEmbeddingBlob(target.rows[0]?.embedding_blob);

  if (!targetVector) {
    return [];
  }

  const candidates = rows.rows.flatMap((row) => {
    const embedding = readEmbeddingBlob(row.embedding_blob);
    const trackId = typeof row.track_id === "string" ? row.track_id : null;

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
  // Self (the target) and three neighbours in decreasing similarity.
  const CORPUS: Seed[] = [
    { embedding: vector(1, 0), logId: "004.0.0A", trackId: "t_self" },
    { embedding: vector(1, 0), logId: "004.1.1A", title: "Identical", trackId: "t_ident" },
    { embedding: vector(1, 1), logId: "004.2.2B", title: "Diagonal", trackId: "t_diag" },
    { embedding: vector(0, 1), logId: "004.3.3C", title: "Orthogonal", trackId: "t_orth" },
  ];

  it("returns the coordinate-bearing neighbours in descending sonic similarity", async () => {
    await seed(CORPUS);

    const findings = await getSimilarFindings("t_self");

    // identical (cos 1) > diagonal (~0.707) > orthogonal (0). `t_self` never appears
    // (the self-exclusion predicate).
    expect(findings.map((finding) => finding.trackId)).toEqual(["t_ident", "t_diag", "t_orth"]);
  });

  it("resolves the target by Log ID as well as by track id", async () => {
    await seed(CORPUS);

    const findings = await getSimilarFindings("004.0.0A");

    expect(findings.map((finding) => finding.trackId)).toEqual(["t_ident", "t_diag", "t_orth"]);
  });

  it("maps each neighbour to the row's display fields (cover, coordinate, identity)", async () => {
    await seed(CORPUS);

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

    const findings = await getSimilarFindings("t_self", 2);

    expect(findings.map((finding) => finding.trackId)).toEqual(["t_ident", "t_diag"]);
  });

  it("SKIPS a finding with no blob rather than ranking it", async () => {
    // The ranking reads the native `embedding_blob` column and the DB does the cosine in SQL.
    // A blobless finding is dropped, never pulled into the isolate. This is safe because the
    // WRITE PATH sets `embedding_blob = vector32(embedding)` (track-update.ts), so an embedded
    // finding always carries a blob.
    await seed(CORPUS);
    await db.execute(`update tracks set embedding_blob = null where track_id = 't_diag'`);

    const findings = await getSimilarFindings("t_self");

    expect(findings.map((finding) => finding.trackId)).toEqual(["t_ident", "t_orth"]);
  });

  it("excludes a finding with no coordinate (nothing to link to)", async () => {
    await seed([...CORPUS, { embedding: vector(1, 0), logId: null, trackId: "t_uncharted" }]);

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
    await seed([{ embedding: null, logId: "004.9.9Z", trackId: "t_bare" }, ...CORPUS]);

    expect(await getSimilarFindings("t_bare")).toEqual([]);
  });

  it("returns [] when nothing else is embedded", async () => {
    await seed([
      { embedding: vector(1, 0), logId: "004.0.0A", trackId: "t_self" },
      { embedding: null, logId: "004.1.1A", trackId: "t_other" },
    ]);

    expect(await getSimilarFindings("t_self")).toEqual([]);
  });

  // ── THE PIN ────────────────────────────────────────────────────────────────
  it("returns exactly what the in-isolate oracle returns (same findings, same order)", async () => {
    const corpus: Seed[] = Array.from({ length: 40 }, (_, index) => ({
      embedding: pseudoVector(index + 1),
      logId: `00${index % 9}.${index}.1A`,
      trackId: `t_${String(index).padStart(2, "0")}`,
    }));

    await seed(corpus);

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
