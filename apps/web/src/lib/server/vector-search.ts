// THE COARSE-SCAN + EXACT-RESCORE VECTOR PRIMITIVE (RFC vector-search-scale, slice A).
//
// One shared shape behind every live similarity read — sonic search (search.ts), the per-user
// recommendations engine (recommendations.ts), and the `/artists?like=` multi-artist scan
// (artist-dossier.ts). It keeps the ratified exact-`vector_distance_cos`-scan model (no ANN index,
// docs/local-database.md) but cuts the one cost that grows with the catalogue: the bytes the WIDE
// scan drags per row. A 1024-d float32 vector is 4,096 B; its int8 sibling (`vector8`) is 1,035 B —
// ~4× smaller (measured). So the corpus-sized pass ranks the COMPACT `embedding_f8` codes, takes
// the top-N candidates, and then rescores JUST those N against the exact `embedding_blob` float32
// vectors for the final order. Recall is preserved because the rescore is exact and N over-fetches
// the requested K by {@link COARSE_OVERFETCH}× — measured 100% top-K recall vs a brute-force exact
// rank on 1024-d vectors (embedding.test.ts / the hosted proof harness).
//
// ── THE FOUR RATIFIED RULES STILL HOLD (embedding.ts / docs/local-database.md) ────────────────
//   1. RANK IN SQL. Both passes `order by … limit` in the database; only `(id, distance)` pairs
//      cross the wire, never a vector — the coarse pass over the corpus, the rescore over ≤N ids.
//   2. BIND EVERY PROBE AS A RAW BLOB. The coarse probe is a raw f8 blob (a stored code re-bound,
//      or one libSQL encoded via `SELECT vector8(?)`); the rescore probe is a raw f32 blob
//      (`toVectorProbe`). NEVER an inline `vector8(?text)` on the hot scan — that re-parses the
//      probe per row (the 14× hosted cliff rule 2 names). One-parse, one round trip.
//   3. NO `libsql_vector_idx`. Still an exact scan behind a btree pre-filter — the coarse pass is
//      the exact scan, just over a 4×-smaller column.
//   4. NO `union all` PER PROBE. Multi-probe folds into ONE pass: `min(vector_distance_cos(col, ?),
//      …)` in the select list (one-arg `min()` is the aggregate, so a single probe binds bare).
//
// ── THE MID-BACKFILL COVER ─────────────────────────────────────────────────────────────────────
// `embedding_f8` is NULL on rows embedded before the column existed until `backfill_vector_codes`
// drains them. The coarse scan ranks `coalesce(<f8>, vector8(vector_extract(<f32>)))`, so an
// un-encoded row still ranks (re-encoding its f32 for that one row, no payload saving) rather than
// silently dropping out — 100% recall holds THROUGHOUT the backfill, not only after it. Once the
// sweep completes the coalesce is a cheap non-null passthrough and the ~4× saving is universal.

import { type Client } from "@libsql/client/web";
import { typedRows } from "./db";

/**
 * How many candidates the coarse pass over-fetches per requested K before the exact rescore cuts
 * back to K. 8× is comfortably above the measured recall floor (top-K recall was already 100% at
 * 4× on 1024-d vectors) with headroom for the structured, less-separable regions of a real
 * embedding space. Raising it widens the (still bounded) rescore `IN (…)` set; lowering it risks a
 * true top-K row missing the coarse cut.
 */
export const COARSE_OVERFETCH = 8;

/**
 * The hard ceiling on the coarse candidate set, so the rescore `WHERE id IN (…)` statement stays a
 * bounded, sane size regardless of K (a large `limit` × {@link COARSE_OVERFETCH} is clamped here).
 * Well under libSQL's bind-parameter limit even with the probe binds, and large enough that the
 * exact rescore of that many ids is a cheap PK-keyed read, not a second corpus scan.
 */
export const MAX_COARSE_CANDIDATES = 800;

/**
 * The coarse-scan COLUMN expression: the stored int8 code, or — for a row the backfill has not
 * reached yet — its f32 vector re-encoded to int8 on the fly (`vector8(vector_extract(<f32>))`).
 * See the module header's mid-backfill cover. After the backfill completes this is a cheap
 * non-null passthrough of `<f8Column>`.
 */
export function coarseColumnSql(f8Column: string, f32Column: string): string {
  return `coalesce(${f8Column}, vector8(vector_extract(${f32Column})))`;
}

/**
 * The max-similarity (= min-distance) fold over one column and N probes: `min(vector_distance_cos(
 * col, ?), …)` — or the bare distance for a single probe (rule 4: one-arg `min()` is the aggregate,
 * which would collapse the scan to one row). Each `?` binds ONE probe blob in select-list order.
 * Shared by the coarse pass (int8 column, f8 probes) and the rescore (float32 column, f32 probes),
 * so the max-similarity-to-nearest-probe semantics (The Ear's never-a-centroid doctrine,
 * docs/the-ear.md) are identical at both stages.
 */
export function minCosDistanceSql(column: string, probeCount: number): string {
  const terms = Array.from({ length: probeCount }, () => `vector_distance_cos(${column}, ?)`);

  return probeCount === 1 ? (terms[0] ?? "") : `min(${terms.join(", ")})`;
}

/** One ranked winner the primitive returns — an opaque id and its EXACT (rescored) cosine distance. */
export type RankedRow = { distance: number; id: string };

/** Everything the two-pass rank needs. The caller owns the FROM/WHERE and the projection it hydrates. */
export type CoarseRescoreOptions = {
  /** The COARSE pass FROM (the corpus-sized scan): e.g. `tracks t left join findings f on …`. */
  coarseFrom: string;
  /** The raw int8 probe blob(s) — a stored `*_f8` code re-bound, or `SELECT vector8(?)` output. */
  coarseProbes: Uint8Array[];
  /** The raw float32 probe blob(s) (`toVectorProbe`) for the exact rescore — SAME probes, exact form. */
  exactProbes: Uint8Array[];
  /** The int8 column expression base (e.g. `t.embedding_f8`), wrapped by {@link coarseColumnSql}. */
  f8Column: string;
  /** The float32 column (e.g. `t.embedding_blob`) — the rescore ranks this and gates on its non-null. */
  f32Column: string;
  /** The id column (e.g. `t.track_id`), returned as `id` and used to key the rescore's `IN (…)`. */
  idColumn: string;
  /** The final top-K after the exact rescore. */
  k: number;
  /** The RESCORE pass FROM (a PK-keyed read over the ≤N candidates): e.g. `tracks t`. */
  rescoreFrom: string;
  /** The metadata pre-filter on the coarse scan (key/bpm/certified/exclusions), composed with `and`. */
  where: string;
  /** The bind args for {@link where}, in SQL-text order (they follow the coarse probes). */
  whereArgs: (number | string)[];
};

/**
 * Run the two-pass rank and return the exact top-K `{ id, distance }`, nearest first. The heart of
 * every similarity read; the caller hydrates the winner ids into its own DTO (search hits, rec
 * items, artist identities) preserving this order.
 *
 * PASS 1 (coarse): one scan of `coarseFrom` ranking the int8 codes, `order by <fold> limit N`
 * (N = min(k × {@link COARSE_OVERFETCH}, {@link MAX_COARSE_CANDIDATES})). The metadata pre-filter
 * `where` narrows the candidate set before the vector work (the ratified btree pre-filter lever).
 * PASS 2 (rescore): the ≤N candidate ids re-ranked against the exact float32 `f32Column`,
 * `order by <fold> limit k`. Only ids + distances cross the wire in either pass (rule 1).
 *
 * Returns `[]` when the coarse pass finds nothing. Deterministic: both passes tie-break on the id.
 */
export async function coarseRescoreRank(
  db: Client,
  options: CoarseRescoreOptions,
): Promise<RankedRow[]> {
  const {
    coarseFrom,
    coarseProbes,
    exactProbes,
    f8Column,
    f32Column,
    idColumn,
    k,
    rescoreFrom,
    where,
    whereArgs,
  } = options;

  if (k <= 0 || coarseProbes.length === 0 || exactProbes.length === 0) {
    return [];
  }

  const candidateLimit = Math.min(k * COARSE_OVERFETCH, MAX_COARSE_CANDIDATES);
  const coarseColumn = coarseColumnSql(f8Column, f32Column);
  const coarseFold = minCosDistanceSql(coarseColumn, coarseProbes.length);

  // PASS 1 — the corpus-sized scan over the compact int8 codes. Probes bind first (select-list
  // order), then the pre-filter args, then the candidate limit.
  const coarseResult = await db.execute({
    args: [...coarseProbes, ...whereArgs, candidateLimit],
    sql: `select ${idColumn} as id, ${coarseFold} as dist
          from ${coarseFrom}
          where ${where}
          order by dist asc, ${idColumn} asc
          limit ?`,
  });

  const candidateIds = typedRows<{ dist: number | null; id: string }>(coarseResult.rows)
    .filter((row) => row.dist !== null)
    .map((row) => row.id);

  if (candidateIds.length === 0) {
    return [];
  }

  // PASS 2 — the exact rescore of just the coarse winners against the full float32 vectors. A
  // PK-keyed read over ≤N ids, not a corpus scan. The candidates already cleared the metadata
  // pre-filter, so the rescore only re-ranks by exact distance (guarding a non-null vector).
  const rescoreFold = minCosDistanceSql(f32Column, exactProbes.length);
  const placeholders = candidateIds.map(() => "?").join(", ");
  const rescoreResult = await db.execute({
    args: [...exactProbes, ...candidateIds, k],
    sql: `select ${idColumn} as id, ${rescoreFold} as dist
          from ${rescoreFrom}
          where ${idColumn} in (${placeholders}) and ${f32Column} is not null
          order by dist asc, ${idColumn} asc
          limit ?`,
  });

  return typedRows<{ dist: number | null; id: string }>(rescoreResult.rows).flatMap((row) =>
    row.dist === null ? [] : [{ distance: row.dist, id: row.id }],
  );
}

/**
 * Encode a float vector into a RAW int8 (`vector8`) probe blob, the form the coarse scan binds
 * (rule 2 — a blob parsed once, never inline `vector8(?text)` re-parsed per row). It is ONE cheap
 * O(1) round trip (`SELECT vector8(?)`), used only when the probe is NOT already a stored code —
 * i.e. an artist-mean or an anchor whose f8 is not otherwise in hand. A stored `*_f8` code is
 * re-bound directly via {@link readRawBlob} with no round trip.
 */
export async function encodeF8Probe(db: Client, vector: number[]): Promise<Uint8Array | null> {
  const result = await db.execute({
    args: [JSON.stringify(vector)],
    sql: `select vector8(?) as p`,
  });
  const cell: unknown = result.rows[0]?.p;

  if (cell instanceof ArrayBuffer) {
    return new Uint8Array(cell);
  }

  if (ArrayBuffer.isView(cell)) {
    return new Uint8Array(cell.buffer.slice(cell.byteOffset, cell.byteOffset + cell.byteLength));
  }

  return null;
}
