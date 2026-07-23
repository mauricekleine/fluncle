// The audio-embedding vector core — the pure math AND the SQL contract of the MuQ
// similarity pipeline (docs/track-lifecycle.md). The box's `fluncle-embed` cron
// produces a 1024-d MuQ vector per finding and the agent-tier `update_track` path
// stores it as a native libSQL `F32_BLOB(1024)` in `tracks.embedding_blob` (the form
// the DATABASE can rank) via `vector32()` — the sole stored form and the source of
// truth. Everything downstream — `list_similar_tracks`, the `/mix` rail, a galaxy's
// core-first order, the `fluncle-cluster` corpus read — ranks IN SQL against the blob.
//
// WHY THE RANKING MOVED INTO SQL. It used to store the vector as JSON too and pull every
// row's JSON into
// the isolate and cosine-rank there. That path is dead (measured; the numbers live in
// docs/local-database.md "Local is not production"): a 1024-d vector is 21,804 B as
// JSON, so the unpaginated
// candidate scan hit `turso dev`'s 10 MiB response cap at 460 embedded findings (row
// 460 threw RESPONSE_TOO_LARGE — a THIS-YEAR wall, not a 100k one), and on hosted
// Turso — which has no cap — it would simply have kept growing into the Worker's
// 128 MB isolate (2,067 MiB transferred / 689 MB of JS heap at 100k). The exact scan
// in SQL returns the winners only: ~2.5 KB, one round trip, 100% recall.
//
// THE FOUR RULES THAT MAKE IT WORK, all measured:
//   1. Rank with `vector_distance_cos` in SQL, never in the isolate.
//   2. BIND THE PROBE AS A RAW BLOB (`toVectorProbe`), never as a JSON string. A text
//      probe makes the database re-parse 21 KB of JSON once per row: 26,700 ms vs
//      1,883 ms at 100k on hosted. The cliff DOES NOT REPRODUCE LOCALLY (sqld: 175 ms
//      either way), so dev will never warn you about it.
//   3. NEVER `CREATE INDEX … libsql_vector_idx` on a populated table. On hosted it
//      failed with `database is locked` and wedged the database's WRITE path for 20+
//      minutes; locally it silently builds an EMPTY index. The exact scan (plus a
//      btree pre-filter where the query allows one) is the ratified shape — there is
//      no ANN index here, by decision.
//   4. NEVER fan a MULTI-probe scan out as `union all` branches over a CTE — the
//      planner flattens the CTE and re-executes the candidate scan once per branch
//      (12 probes = 12 full blob-dragging passes; 63 s hosted, measured 2026-07-18
//      on /recommendations). Fold the probes into ONE pass instead:
//      `min(vector_distance_cos(vec, ?), …)` in the select list — and mind that
//      one-argument `min()` is the AGGREGATE, so a single probe binds bare.
//
// The pure functions stay side-effect-free so they are unit tested with fixture
// vectors (no DB, no network); `readEmbeddingBlob`/`toVectorProbe` are the only
// bridge to the wire format.

/**
 * The MuQ-large embedding width. `MuQ-large-msd-iter`'s `last_hidden_state`,
 * mean-pooled over time, is a 1024-d vector — the RFC's decided model + pooling.
 * A stored vector of any other length is malformed and rejected on parse.
 */
export const EMBEDDING_DIMS = 1024;

/**
 * Validate an already-parsed value as an embedding vector: a plain array of exactly
 * `EMBEDDING_DIMS` finite numbers. Returns the vector (copied into a dense
 * number array) or `null` when the shape is wrong — a defensive gate so a malformed
 * write never lands in the column and a legacy/garbage row never poisons a ranking.
 */
export function coerceEmbedding(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length !== EMBEDDING_DIMS) {
    return null;
  }

  const vector: number[] = [];

  for (let index = 0; index < EMBEDDING_DIMS; index += 1) {
    const value = raw[index];

    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }

    vector.push(value);
  }

  return vector;
}

/**
 * Cosine similarity of two equal-width vectors, in [-1, 1]. MuQ vectors are
 * L2-normalized at embed time (so this reduces to a dot product), but we do NOT
 * assume unit length — a re-embedded or hand-fixtured vector might not be normalized,
 * so we divide by the magnitudes for a correct result either way. A zero-magnitude
 * vector (degenerate) scores 0 rather than dividing by zero.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < length; index += 1) {
    const ai = a[index] ?? 0;
    const bi = b[index] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);

  return denominator === 0 ? 0 : dot / denominator;
}

/** A ranking candidate: some opaque `item` paired with its embedding vector. */
export type EmbeddingCandidate<T> = {
  embedding: number[];
  item: T;
};

/**
 * Rank `candidates` by descending cosine similarity to `target` and return the top
 * `limit` items. Brute-force (O(n·d)) over vectors ALREADY IN MEMORY — which is why
 * no DB read path calls it anymore: getting the vectors here is the thing that does
 * not scale (see the module header), not the arithmetic. It survives for the bounded
 * in-memory rankings — the artist-dossier means and the galaxy-adjacency strip, whose
 * inputs are a handful of vectors, not the corpus.
 *
 * Deterministic: ties break toward the earlier candidate (a stable sort), so a fixed
 * candidate order yields a fixed result. A non-positive `limit` returns nothing.
 */
export function rankBySimilarity<T>(
  target: number[],
  candidates: EmbeddingCandidate<T>[],
  limit: number,
): T[] {
  if (limit <= 0) {
    return [];
  }

  return candidates
    .map((candidate, index) => ({
      index,
      item: candidate.item,
      score: cosineSimilarity(target, candidate.embedding),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((scored) => scored.item);
}

// ── The SQL contract (the blob path) ─────────────────────────────────────────

/**
 * Bind a probe vector for `vector_distance_cos(…, ?)` as a RAW float32 BLOB — the
 * single most load-bearing detail in this file (module header, rule 2). The same
 * query with the same probe expressed as a JSON string costs 26,700 ms at 100k on
 * hosted Turso against 1,883 ms for these bytes, because `vector32()` re-parses the
 * text once per scanned row. Local sqld shows NO difference (175 ms either way), so
 * nothing in dev will ever catch a regression here — only this comment will.
 */
export function toVectorProbe(vector: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}

/**
 * Decode an `F32_BLOB` cell back into a vector, or `null` when it is absent/malformed.
 *
 * THE DRIVER QUIRK: `@libsql/client` hands a blob cell back as an **`ArrayBuffer`**,
 * not a `Uint8Array` — so a `instanceof Uint8Array` check silently drops every row.
 * Both are accepted here. A byte length that is not a whole number of float32s, or
 * that does not match {@link EMBEDDING_DIMS}, is rejected like a malformed JSON vector.
 */
export function readEmbeddingBlob(cell: unknown): number[] | null {
  const buffer =
    cell instanceof ArrayBuffer
      ? cell
      : ArrayBuffer.isView(cell)
        ? cell.buffer.slice(cell.byteOffset, cell.byteOffset + cell.byteLength)
        : null;

  if (!buffer || buffer.byteLength !== EMBEDDING_DIMS * Float32Array.BYTES_PER_ELEMENT) {
    return null;
  }

  return Array.from(new Float32Array(buffer));
}

/**
 * Cosine SIMILARITY from libSQL's cosine DISTANCE (`vector_distance_cos` returns
 * `1 − cos`), so a SQL-ranked row lands on the same scale as {@link cosineSimilarity}.
 * A non-numeric cell (no vector) is `null`.
 */
export function cosineFromDistance(distance: unknown): number | null {
  return typeof distance === "number" && Number.isFinite(distance) ? 1 - distance : null;
}

/**
 * Read a blob cell back as its RAW bytes (a `Uint8Array`), or `null` when absent — the
 * bridge for RE-BINDING a stored vector blob as a probe WITHOUT decoding it. The int8
 * COARSE scan (lib/server/vector-search.ts) binds a stored `embedding_f8`/`centroid_f8`
 * blob straight back as the `vector_distance_cos` probe (rule 2 — a raw blob, parsed once,
 * never a re-parsed text vector). Unlike {@link readEmbeddingBlob} it does NOT decode to
 * floats or assume a width (an f8 blob is 1 byte/dim + 8 param bytes, not a whole number of
 * float32s), so it works for any vector type. The driver hands a blob back as an
 * `ArrayBuffer` (not a `Uint8Array`) — both are normalized here (the same quirk
 * `readEmbeddingBlob` guards).
 */
export function readRawBlob(cell: unknown): Uint8Array | null {
  if (cell instanceof ArrayBuffer) {
    return new Uint8Array(cell);
  }

  if (ArrayBuffer.isView(cell)) {
    return new Uint8Array(cell.buffer.slice(cell.byteOffset, cell.byteOffset + cell.byteLength));
  }

  return null;
}

// ── The int8 quantization reference (a pure model of libSQL's `vector8`) ──────────────

/**
 * The int8 code libSQL's `vector8()` produces for one component ladder: a PURE, no-DB model of
 * the linear per-vector quantization the DATABASE does server-side. libSQL maps each vector's own
 * `[min, max]` range linearly onto the 0..255 int8 grid (its documented "linearly quantized to the
 * 0-255 range", 1 byte/dim + 8 param bytes), so the code is `round((x − min) / (max − min) · 255)`.
 *
 * This is NOT on any write path — `vector8()` is the single source of truth for the STORED
 * `embedding_f8`/`centroid_f8` bytes (track-update.ts / artist-dossier.ts), and the wide scan binds
 * a probe libSQL itself encoded. The model exists so the COARSE-vs-EXACT recall contract can be
 * unit-tested on fixtures WITHOUT a database (embedding.test.ts): quantize a fixture with this,
 * cosine-rank the dequantized codes, and assert the coarse top-N still contains the exact top-K —
 * the property the two-pass scan (lib/server/vector-search.ts) leans on. A degenerate vector (all
 * one value, so `max === min`) maps every component to 0 — the same collapse libSQL's grid makes.
 */
export function quantizeToInt8(vector: number[]): number[] {
  if (vector.length === 0) {
    return [];
  }

  let min = vector[0] ?? 0;
  let max = min;

  for (const value of vector) {
    if (value < min) {
      min = value;
    }

    if (value > max) {
      max = value;
    }
  }

  const span = max - min;

  if (span === 0) {
    return vector.map(() => 0);
  }

  return vector.map((value) => Math.round(((value - min) / span) * 255));
}

/**
 * Dequantize an int8 code ladder ({@link quantizeToInt8}) back toward its float range, given the
 * `[min, max]` the code was built from — the inverse the model's recall test uses to score coarse
 * candidates on the SAME approximate vectors the database ranks. `code / 255 · (max − min) + min`.
 */
export function dequantizeInt8(codes: number[], min: number, max: number): number[] {
  const span = max - min;

  return codes.map((code) => (code / 255) * span + min);
}
