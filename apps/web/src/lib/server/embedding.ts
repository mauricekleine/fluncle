import { type InStatement } from "@libsql/client";

export const EMBEDDING_DIMS = 1024;

export const CLEAR_EMBEDDING_SQL = `has_embedding = 0`;

export const CLEAR_EMBEDDING_SATELLITE_SQL = `delete from track_embeddings
              where track_id = ?
                and not exists (select 1 from tracks
                                where tracks.track_id = track_embeddings.track_id
                                  and tracks.has_embedding = 1)`;

export function clearEmbeddingSatellite(trackId: string): InStatement {
  return { args: [trackId], sql: CLEAR_EMBEDDING_SATELLITE_SQL };
}

export const SET_EMBEDDING_SQL = `has_embedding = 1`;

export function writeEmbeddingSatellite(trackId: string, embeddingJson: string): InStatement {
  return {
    args: [trackId, embeddingJson],
    sql: `insert into track_embeddings (track_id, embedding_blob) values (?, vector32(?))
              on conflict(track_id) do update set embedding_blob = excluded.embedding_blob
                where track_embeddings.embedding_blob <> excluded.embedding_blob`,
  };
}

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

export type EmbeddingCandidate<T> = {
  embedding: number[];
  item: T;
};

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

export function toVectorProbe(vector: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}

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

export function cosineFromDistance(distance: unknown): number | null {
  return typeof distance === "number" && Number.isFinite(distance) ? 1 - distance : null;
}
