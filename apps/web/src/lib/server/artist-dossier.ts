// The artist dossier — the small intelligence file behind each `/artist/<slug>`
// page (artist-relationship doc). Two derived reads, both computed at page-load
// scale (the archive is ~hundreds of findings, so a brute-force pass in the route
// loader is instant — no cron, no stored aggregate):
//
//   1. The SIGNATURE — the artist's fingerprint across the findings Fluncle has
//      logged: when they first crossed his path (the first-found date behind the
//      voice frame). Pure, from the findings already loaded for the grid — no
//      extra query.
//   2. The NEIGHBOURS ("similar artists") — the artists whose findings sit nearest
//      in MuQ embedding space, ranked by the cosine similarity of artist-level MEAN
//      embeddings (the mean over each artist's findings' vectors). This is the
//      same sonic-similarity space that powers the `/log` "close in sound" row
//      (lib/server/embedding.ts), lifted from finding↔finding to artist↔artist.
//
// The vector math lives in `embedding.ts` (cosineSimilarity / rankBySimilarity)
// and is reused verbatim here; the pure functions below are kept side-effect-free
// so they unit-test directly with fixture vectors (artist-dossier.test.ts).

import { getDb, typedRows } from "./db";
import { type EmbeddingCandidate, readEmbeddingBlob, rankBySimilarity } from "./embedding";

/** How many "same sector" neighbours the artist page shows (top-N, self excluded). */
export const ARTIST_NEIGHBOURS_LIMIT = 4;

/** The pure signature summary derived from an artist's findings. */
export type ArtistSignature = {
  /** The ISO date of the earliest finding — when the artist first crossed his path. */
  firstFoundAt: string | undefined;
};

/** A neighbouring artist link — the minimal identity the "similar artists" row needs. */
export type ArtistNeighbour = {
  /** The artist's Spotify avatar (undefined → the chip renders a monogram tile). */
  imageUrl: string | undefined;
  name: string;
  slug: string;
};

/** The findings-shaped input the signature is derived from (a subset of TrackListItem). */
export type SignatureFinding = {
  addedAt: string;
};

/**
 * The mean (centroid) of a set of equal-width embedding vectors, or `null` when the
 * set is empty. Component-wise average; a missing component reads 0 (defensive —
 * DB-sourced vectors are all {@link EMBEDDING_DIMS}-wide, but a fixtured set might
 * be ragged). The mean is the artist's position in sonic space: averaging their
 * findings' vectors collapses a discography into one point to compare against.
 */
export function meanEmbedding(vectors: number[][]): number[] | null {
  if (vectors.length === 0) {
    return null;
  }

  let width = 0;
  for (const vector of vectors) {
    if (vector.length > width) {
      width = vector.length;
    }
  }

  const sum = Array.from<number>({ length: width }).fill(0);

  for (const vector of vectors) {
    for (let index = 0; index < width; index += 1) {
      sum[index] = (sum[index] ?? 0) + (vector[index] ?? 0);
    }
  }

  return sum.map((component) => component / vectors.length);
}

/** An artist and every embedding vector across their coordinate-bearing findings. */
export type ArtistEmbeddingGroup = {
  artistId: string;
  imageUrl: string | undefined;
  name: string;
  slug: string;
  vectors: number[][];
};

/**
 * Rank the artists sonically nearest to `targetArtistId` by the cosine similarity
 * of artist-level MEAN embeddings. Only groups with ≥1 vector contribute (a mean
 * needs a vector); the target itself is excluded from its own results. Returns `[]`
 * when the target is absent or has no embedded finding (nothing to compare from) —
 * never throws. Deterministic: ties break toward the earlier candidate via
 * `rankBySimilarity`, so a fixed group order yields a fixed result.
 */
export function rankSimilarArtists(
  targetArtistId: string,
  groups: ArtistEmbeddingGroup[],
  limit: number,
): ArtistNeighbour[] {
  const targetGroup = groups.find((group) => group.artistId === targetArtistId);
  const target = targetGroup ? meanEmbedding(targetGroup.vectors) : null;

  if (!target) {
    return [];
  }

  const candidates: EmbeddingCandidate<ArtistNeighbour>[] = [];

  for (const group of groups) {
    if (group.artistId === targetArtistId) {
      continue;
    }

    const mean = meanEmbedding(group.vectors);

    if (mean) {
      candidates.push({
        embedding: mean,
        item: { imageUrl: group.imageUrl, name: group.name, slug: group.slug },
      });
    }
  }

  return rankBySimilarity(target, candidates, limit);
}

/**
 * Derive the pure signature (the first-found date) from an artist's findings — the
 * earliest `addedAt`, or undefined for an empty set. It degrades cleanly: a
 * barely-enriched artist still yields an honest signature (the voice frame's
 * "first crossed his path on …" opener).
 */
export function summarizeArtistSignature(findings: SignatureFinding[]): ArtistSignature {
  let firstFoundAt: string | undefined;

  for (const finding of findings) {
    if (finding.addedAt && (firstFoundAt === undefined || finding.addedAt < firstFoundAt)) {
      firstFoundAt = finding.addedAt;
    }
  }

  return { firstFoundAt };
}

type NeighbourRow = {
  artist_id: string;
  embedding_blob: unknown;
  image_url: string | null;
  name: string;
  slug: string;
};

/**
 * The artist page's "same sector" neighbours — the DB-backed side of the dossier.
 * Loads every (artist, finding-vector) pair for coordinate-bearing, embedded findings,
 * groups the vectors per artist, and cosine-ranks the artist-level means against the
 * target's. Only artists with ≥1 embedded finding participate, so the result is `[]` for
 * an artist whose findings aren't embedded yet (the `fluncle-embed` cron hasn't drained
 * them) — the block simply doesn't render. One query for the whole corpus; the grouping
 * + ranking is pure (`rankSimilarArtists`).
 *
 * THIS ONE STILL READS THE VECTORS, and it is the only similarity path that does. An
 * artist-level MEAN cannot be expressed as a single probe against a btree-narrowed scan
 * — libSQL has no vector aggregate — so ranking it in SQL would need a STORED artist
 * centroid (a new derived artifact, with a freshness cascade every time a finding is
 * re-embedded or an artist link changes). That is a design change, not a scale fix, and
 * it is deliberately not made here.
 *
 * What IS done: the vectors come back as `F32_BLOB`s (4,096 B) rather than JSON text
 * (21,804 B) — 5.4x less. The wall that matters (`turso dev`'s 10 MiB response cap,
 * which this query hit at ~460 embedded findings exactly as `getSimilarFindings` did)
 * moves out to ~2,400, and the isolate's heap at 100k drops from ~689 MB to ~130 MB.
 * The ranking is bit-identical: `embedding_blob` holds the same float32s the JSON
 * printed. The stored-centroid design is the recorded follow-up before the archive
 * reaches the low thousands.
 */
export async function getArtistNeighbours(
  artistId: string,
  limit = ARTIST_NEIGHBOURS_LIMIT,
): Promise<ArtistNeighbour[]> {
  if (limit <= 0) {
    return [];
  }

  const db = await getDb();
  const result = await db.execute({
    sql: `select a.id as artist_id, a.name as name, a.slug as slug,
                 a.image_url as image_url, t.embedding_blob as embedding_blob
          from artists a
          join track_artists ta on ta.artist_id = a.id
          join (findings join tracks on tracks.track_id = findings.track_id) t on t.track_id = ta.track_id
          where t.log_id is not null and t.embedding_blob is not null`,
  });

  const groups = new Map<string, ArtistEmbeddingGroup>();

  for (const row of typedRows<NeighbourRow>(result.rows)) {
    // The driver hands a blob back as an ArrayBuffer, not a Uint8Array (embedding.ts).
    const embedding = readEmbeddingBlob(row.embedding_blob);

    if (!embedding) {
      continue;
    }

    const existing = groups.get(row.artist_id);

    if (existing) {
      existing.vectors.push(embedding);
    } else {
      groups.set(row.artist_id, {
        artistId: row.artist_id,
        imageUrl: row.image_url ?? undefined,
        name: row.name,
        slug: row.slug,
        vectors: [embedding],
      });
    }
  }

  return rankSimilarArtists(artistId, [...groups.values()], limit);
}
