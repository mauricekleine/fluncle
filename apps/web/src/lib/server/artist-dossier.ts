// The artist dossier — the small intelligence file behind each `/artist/<slug>`
// page (artist-relationship doc). Two derived reads, both computed at page-load
// scale (the archive is ~hundreds of findings, so a brute-force pass in the route
// loader is instant — no cron, no stored aggregate):
//
//   1. The SIGNATURE — the artist's fingerprint across the findings Fluncle has
//      logged: when they first crossed his path, the tempo band their tunes roll
//      in (range + median), and the key spread. Pure, from the findings already
//      loaded for the grid — no extra query.
//   2. The NEIGHBOURS ("same sector") — the artists whose findings sit nearest in
//      MuQ embedding space, ranked by the cosine similarity of artist-level MEAN
//      embeddings (the mean over each artist's findings' vectors). This is the
//      same sonic-similarity space that powers the `/log` "close in sound" row
//      (lib/server/embedding.ts), lifted from finding↔finding to artist↔artist.
//
// The vector math lives in `embedding.ts` (cosineSimilarity / rankBySimilarity)
// and is reused verbatim here; the pure functions below are kept side-effect-free
// so they unit-test directly with fixture vectors (artist-dossier.test.ts).

import { getDb, typedRows } from "./db";
import { type EmbeddingCandidate, parseEmbedding, rankBySimilarity } from "./embedding";

/** How many "same sector" neighbours the artist page shows (top-N, self excluded). */
export const ARTIST_NEIGHBOURS_LIMIT = 4;

/** The tempo band across an artist's findings — the range plus its median. */
export type ArtistBpmRange = {
  /** The fastest logged finding's BPM (rounded for display upstream). */
  max: number;
  /** The median BPM — the characteristic tempo, not skewed by an outlier. */
  median: number;
  /** The slowest logged finding's BPM. */
  min: number;
};

/** The pure signature summary derived from an artist's findings. */
export type ArtistSignature = {
  /** The tempo band, or undefined when no finding carries a BPM yet. */
  bpm: ArtistBpmRange | undefined;
  /** The ISO date of the earliest finding — when the artist first crossed his path. */
  firstFoundAt: string | undefined;
  /** The distinct musical keys across the findings, sorted, for the key-spread field. */
  keys: string[];
};

/** A neighbouring artist link — the minimal identity the "same sector" row needs. */
export type ArtistNeighbour = {
  name: string;
  slug: string;
};

/** The findings-shaped input the signature is derived from (a subset of TrackListItem). */
export type SignatureFinding = {
  addedAt: string;
  bpm: number | undefined;
  key: string | undefined;
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
      candidates.push({ embedding: mean, item: { name: group.name, slug: group.slug } });
    }
  }

  return rankBySimilarity(target, candidates, limit);
}

/** The median of a non-empty numeric list (average of the two middle values when even). */
function median(sortedAscending: number[]): number {
  const count = sortedAscending.length;
  const mid = Math.floor(count / 2);

  if (count % 2 === 1) {
    return sortedAscending[mid] ?? 0;
  }

  return ((sortedAscending[mid - 1] ?? 0) + (sortedAscending[mid] ?? 0)) / 2;
}

/**
 * Derive the pure signature (first-found date, tempo band, key spread) from an
 * artist's findings. Every field degrades independently: a set with no BPMs yields
 * `bpm: undefined`, a set with no keys yields `keys: []`, and an empty set yields
 * all-empty — so a barely-enriched artist still renders a clean, honest dossier.
 */
export function summarizeArtistSignature(findings: SignatureFinding[]): ArtistSignature {
  let firstFoundAt: string | undefined;
  const bpms: number[] = [];
  const keys = new Set<string>();

  for (const finding of findings) {
    if (finding.addedAt && (firstFoundAt === undefined || finding.addedAt < firstFoundAt)) {
      firstFoundAt = finding.addedAt;
    }

    if (typeof finding.bpm === "number" && Number.isFinite(finding.bpm)) {
      bpms.push(finding.bpm);
    }

    const key = finding.key?.trim();
    if (key) {
      keys.add(key);
    }
  }

  let bpm: ArtistBpmRange | undefined;
  if (bpms.length > 0) {
    const sorted = [...bpms].sort((left, right) => left - right);
    bpm = {
      max: sorted[sorted.length - 1] ?? 0,
      median: median(sorted),
      min: sorted[0] ?? 0,
    };
  }

  return {
    bpm,
    firstFoundAt,
    keys: [...keys].sort((left, right) => left.localeCompare(right)),
  };
}

type NeighbourRow = {
  artist_id: string;
  embedding_json: string;
  name: string;
  slug: string;
};

/**
 * The artist page's "same sector" neighbours — the DB-backed side of the dossier.
 * Loads every (artist, finding-embedding) pair for coordinate-bearing, embedded
 * findings, groups the vectors per artist, and cosine-ranks the artist-level means
 * against the target's. Only artists with ≥1 embedded finding participate, so the
 * result is `[]` for an artist whose findings aren't embedded yet (the `fluncle-embed`
 * cron hasn't drained them) — the block simply doesn't render. One query for the
 * whole corpus; the grouping + ranking is pure (`rankSimilarArtists`).
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
    sql: `select a.id as artist_id, a.name as name, a.slug as slug, t.embedding_json as embedding_json
          from artists a
          join track_artists ta on ta.artist_id = a.id
          join tracks t on t.track_id = ta.track_id
          where t.log_id is not null and t.embedding_json is not null`,
  });

  const groups = new Map<string, ArtistEmbeddingGroup>();

  for (const row of typedRows<NeighbourRow>(result.rows)) {
    const embedding = parseEmbedding(row.embedding_json);

    if (!embedding) {
      continue;
    }

    const existing = groups.get(row.artist_id);

    if (existing) {
      existing.vectors.push(embedding);
    } else {
      groups.set(row.artist_id, {
        artistId: row.artist_id,
        name: row.name,
        slug: row.slug,
        vectors: [embedding],
      });
    }
  }

  return rankSimilarArtists(artistId, [...groups.values()], limit);
}
