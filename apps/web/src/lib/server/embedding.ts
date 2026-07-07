// The audio-embedding vector math — the pure core of the MuQ similarity pipeline
// (docs/rfcs/audio-embedding-rfc.md). The box's `fluncle-embed` cron produces a 1024-d
// MuQ vector per finding and stores it (as a JSON array) in `tracks.embedding_json`
// via the agent-tier `update_track` path; the public `get_similar_findings` op
// cosine-ranks those vectors to power the "more like this" `/log` row. All of that
// leans on the four pure functions here, kept side-effect-free so they are unit
// tested directly with fixture vectors (no DB, no network).

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
 * Parse a stored `embedding_json` string into a validated vector, or `null` when it
 * is absent / not JSON / the wrong shape. The wire + storage format is a bare JSON
 * array of {@link EMBEDDING_DIMS} numbers (the box orchestrator unwraps the Python
 * script's `{ embedding }` envelope to this bare array before the write).
 */
export function parseEmbedding(json: string | null | undefined): number[] | null {
  if (!json) {
    return null;
  }

  let raw: unknown;

  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }

  return coerceEmbedding(raw);
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
 * `limit` items. Brute-force (O(n·d)) — instant at the catalogue's scale (dozens →
 * low thousands); libSQL's native `vector_top_k` is the escape hatch past ~10k (the
 * RFC's §2b note). Deterministic: ties break toward the earlier candidate (a stable
 * sort), so a fixed candidate order yields a fixed result. A non-positive `limit`
 * returns nothing.
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
