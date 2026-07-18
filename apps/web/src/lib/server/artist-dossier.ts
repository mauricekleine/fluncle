// The artist dossier — the small intelligence file behind each `/artist/<slug>`
// page (artist-relationship doc). Two derived reads:
//
//   1. The SIGNATURE — the artist's fingerprint across the findings Fluncle has
//      logged: when they first crossed his path (the first-found date behind the
//      voice frame). Pure, from the findings already loaded for the grid — no
//      extra query.
//   2. The NEIGHBOURS ("similar artists") — the artists sitting nearest in MuQ
//      embedding space, ranked by the cosine similarity of artist-level MEAN
//      embeddings (the mean over EVERY track that credits the artist, findings AND
//      catalogue alike). The same sonic-similarity space that powers the `/log`
//      "close in sound" row (lib/server/embedding.ts), lifted from finding↔finding
//      to artist↔artist — and now the WHOLE embedded archive, not just findings.
//
// WHY THIS IS PRECOMPUTED NOW (D6). The neighbours USED to be a page-load,
// whole-corpus vector read: the loader pulled every (artist, finding-vector) pair,
// grouped, and ranked artist means in the isolate. That is the exact shape
// embedding.ts's header calls dead — it does not survive the catalogue reaching the
// low thousands (the isolate heap + the response cap). So the read moves to two
// STORED, self-healing artifacts (schema.ts): `artist_centroids` (one mean vector per
// artist) and `artist_similar` (the top-K precomputed edges). The `rank_artists` sweep
// below fills them off a corpus FINGERPRINT (the `rank_catalogue` precedent,
// docs/the-ear.md); `getArtistNeighbours` becomes a cheap ordered PK-prefix read of the
// edges. The request path does NO vector math.
//
// The pure math (`meanEmbedding`, `rankSimilarArtists`) stays side-effect-free so it
// unit-tests directly with fixture vectors (artist-dossier.test.ts); the sweep reuses
// `meanEmbedding` for each centroid and ranks the edges IN SQL (never in the isolate).

import { type InStatement } from "@libsql/client/web";
import { getDb, typedRows } from "./db";
import { type EmbeddingCandidate, readEmbeddingBlob, rankBySimilarity } from "./embedding";

/** How many "same sector" neighbours the artist page shows (top-N, self excluded). */
export const ARTIST_NEIGHBOURS_LIMIT = 4;

/**
 * How many precomputed edges the sweep stores per artist. The rail renders
 * {@link ARTIST_NEIGHBOURS_LIMIT} (4); the extra headroom is for the MCP
 * `get_similar_artists` tool, which reads the same `artist_similar` table.
 */
export const ARTIST_SIMILAR_EDGES = 8;

/** How many stale/orphan artists one `rank_artists` tick recomputes (bounds the tick's cost). */
export const ARTIST_RANK_BATCH_SIZE = 100;

/** The pure signature summary derived from an artist's findings. */
export type ArtistSignature = {
  /** The ISO date of the earliest finding — when the artist first crossed his path. */
  firstFoundAt: string | undefined;
};

/** An artist's minimal public identity — the fields a chip / link needs to render. */
export type ArtistIdentity = {
  /** The artist's Spotify avatar (undefined → the chip renders a monogram tile). */
  imageUrl: string | undefined;
  name: string;
  slug: string;
};

/**
 * A neighbouring artist link — the identity the "similar artists" rail renders, plus
 * `certified`: whether the neighbour carries ≥1 finding. A catalogue-only neighbour
 * (`certified: false`) renders in the UNLIT register (DESIGN.md's Unlit Rule — listed,
 * never introduced, no coordinate, no gold), so the rail can show the whole embedded
 * archive without ever presenting an uncertified artist as one of Fluncle's Findings.
 */
export type ArtistNeighbour = ArtistIdentity & {
  certified: boolean;
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
 * when the target is absent or has no embedded vector (nothing to compare from) —
 * never throws. Deterministic: ties break toward the earlier candidate via
 * `rankBySimilarity`, so a fixed group order yields a fixed result.
 *
 * This is the pure, in-isolate expression of the ranking the `rank_artists` sweep does
 * IN SQL (`vector_distance_cos` over `artist_centroids`). It returns the sonic identity
 * only — the lit/unlit `certified` tier is a GRAPH fact assigned at read time
 * (`getArtistNeighbours`), never by this sonic ranker.
 */
export function rankSimilarArtists(
  targetArtistId: string,
  groups: ArtistEmbeddingGroup[],
  limit: number,
): ArtistIdentity[] {
  const targetGroup = groups.find((group) => group.artistId === targetArtistId);
  const target = targetGroup ? meanEmbedding(targetGroup.vectors) : null;

  if (!target) {
    return [];
  }

  const candidates: EmbeddingCandidate<ArtistIdentity>[] = [];

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

// ── The staleness fingerprint (the `rank_catalogue` precedent) ──────────────────────────

/**
 * A leading version so a change to the sweep's ALGORITHM — not just the corpus —
 * invalidates every stored fingerprint and forces one self-healing full re-rank (no bulk
 * write, no manual invalidation). Bump it only when the ranking DECISION changes for
 * artists whose corpus counts did not move. `v1` is the initial catalogue-wide design.
 */
const ARTIST_RANK_LOGIC_VERSION = "v1";

/**
 * The fingerprint of the corpus a centroid/edge was computed against —
 * `"<version>:<embedded tracks>:<track↔artist links>"`. It moves whenever the artist
 * graph's SONIC inputs could change: embed a track and the first number moves (a new
 * vector to fold into a mean); add or repoint an artist↔track link and the second moves
 * (a mean gains or loses a member). A row whose stored fingerprint disagrees with the
 * live one is stale and recomputes on a later tick — so the sweep converges after ANY
 * archive change and needs no invalidation call from the publish/embed/crawl paths.
 * Compared with `<>` (never `<`), so a DELETED track/link is caught like an added one.
 */
export function rankArtistsCorpus(embeddedTracks: number, links: number): string {
  return `${ARTIST_RANK_LOGIC_VERSION}:${embeddedTracks}:${links}`;
}

// ── The sweep (`rank_artists`) ──────────────────────────────────────────────────────────

/** One `rank_artists` tick's outcome — the JSON summary line a `--no-agent` cron prints. */
export type RankArtistsSummary = {
  /** Artist centroids recomputed this tick (a mean re-folded + its top-K edges re-ranked). */
  centroidsComputed: number;
  /** Orphan centroids purged this tick (the artist lost every embedded track). */
  centroidsRemoved: number;
  /** The live corpus fingerprint this tick ranked against. */
  corpus: string;
  /** Distinct edge rows written this tick (`centroidsComputed × ≤K`). */
  edgesWritten: number;
  /** Embedded tracks — the vectors a centroid can fold in. */
  embeddedTracks: number;
  /** Track↔artist links — the graph the means are grouped over. */
  links: number;
  /** Stale/orphan artists still pending after this tick — the "run me again" signal. */
  remaining: number;
};

type ArtistVectorRow = { embedding_blob: unknown };
type StaleArtistRow = { artist_id: string };
type EdgeCandidateRow = { dist: number; neighbour_id: string };

// The stale/orphan candidate set (bound: `corpus`), shared by the sweep and `countStaleArtists`.
// Two arms:
//   1. STALE — an artist crediting ≥1 embedded track whose centroid is missing or carries a
//      fingerprint that disagrees with the live corpus (it must be (re)computed).
//   2. ORPHAN — a centroid whose artist no longer credits ANY embedded track (its vectors were
//      cleared, e.g. a wrong-audio flag) — it must be purged so it stops ranking as a neighbour.
const STALE_ARTISTS_INNER = `select ta.artist_id as artist_id
            from track_artists ta
            join tracks t on t.track_id = ta.track_id
            left join artist_centroids ac on ac.artist_id = ta.artist_id
            where t.embedding_blob is not null
              and (ac.artist_id is null or ac.rank_corpus <> ?)
            union
            select ac.artist_id as artist_id
            from artist_centroids ac
            where not exists (
              select 1 from track_artists ta
              join tracks t on t.track_id = ta.track_id
              where ta.artist_id = ac.artist_id and t.embedding_blob is not null
            )`;

// The tick's batch: the stale/orphan artists oldest-id first (deterministic drain, stable order).
const STALE_ARTISTS_PAGE = `select artist_id from (${STALE_ARTISTS_INNER})
          order by artist_id asc
          limit ?`;

/** Count the stale/orphan artists still pending for `corpus` — the `remaining` gauge. */
async function countStaleArtists(corpus: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [corpus],
    sql: `select count(*) as n from (${STALE_ARTISTS_INNER})`,
  });

  return Number(typedRows<{ n: number }>(result.rows)[0]?.n ?? 0);
}

/**
 * One tick of the similar-artists precompute sweep — the artist-graph sibling of
 * `rankCatalogue` (docs/the-ear.md). It recomputes up to `limit` STALE centroids (each the
 * MEAN over all the artist's embedded tracks — findings AND catalogue) and re-ranks each
 * one's top-{@link ARTIST_SIMILAR_EDGES} sonic neighbours IN SQL, then purges any ORPHAN
 * centroid whose artist lost every embedded track.
 *
 * The tick, in order:
 *   1. Read the live corpus fingerprint (`rankArtistsCorpus`).
 *   2. Take up to `limit` stale/orphan artists (`STALE_ARTISTS_PAGE`), oldest-id first.
 *   3. For each, pull ITS OWN vectors in a bounded per-artist read (never the whole corpus in
 *      one pull; blobs, never JSON text) and take the mean:
 *        · a mean exists → upsert the centroid (stored via `vector32()`, the sole write form),
 *          then re-rank its edges with `vector_distance_cos` scanning `artist_centroids` — the
 *          target's probe is the STORED blob via a subquery, so no vector crosses the wire and
 *          no probe is ever bound as text (embedding.ts rule 2).
 *        · no vectors (an orphan) → delete the centroid + its edges.
 *      Every write is stamped with the fingerprint, so a recomputed artist leaves the stale set.
 *
 * SELF-HEALING + eventual-consistency: staleness is the fingerprint, so any archive change
 * re-ranks the affected rows over later ticks. An early tick may rank an artist against a
 * neighbour whose own centroid is about to refresh, but a centroid's VALUE only moves when that
 * neighbour's embedded-track set changed (most are byte-identical across corpus versions), and
 * continuous archive growth re-ranks the drift on the next fingerprint move — the accepted shape
 * for a browse-adjacent rail (the same self-healing contract as `rankCatalogue`). Idempotent and
 * resume-safe: a crash mid-tick leaves the un-stamped artists stale for the next tick; a re-run on
 * a settled graph is a no-op. `now` is injected so the ranking logic carries no `Date.now`.
 */
export async function rankArtists(
  limit = ARTIST_RANK_BATCH_SIZE,
  now: () => string = () => new Date().toISOString(),
): Promise<RankArtistsSummary> {
  const db = await getDb();
  const bounded = Math.max(0, limit);

  const countResult = await db.execute({
    args: [],
    sql: `select
            (select count(*) from tracks where embedding_blob is not null) as embedded,
            (select count(*) from track_artists) as links`,
  });
  const counts = typedRows<{ embedded: number; links: number }>(countResult.rows)[0];
  const embeddedTracks = Number(counts?.embedded ?? 0);
  const links = Number(counts?.links ?? 0);
  const corpus = rankArtistsCorpus(embeddedTracks, links);

  const staleResult = await db.execute({
    args: [corpus, bounded],
    sql: STALE_ARTISTS_PAGE,
  });
  const staleArtists = typedRows<StaleArtistRow>(staleResult.rows).map((row) => row.artist_id);

  if (staleArtists.length === 0) {
    // `remaining` is COUNTED, never assumed zero (a `limit` of 0 idles with rows still stale).
    return {
      centroidsComputed: 0,
      centroidsRemoved: 0,
      corpus,
      edgesWritten: 0,
      embeddedTracks,
      links,
      remaining: await countStaleArtists(corpus),
    };
  }

  const stamp = now();
  let centroidsRemoved = 0;
  let edgesWritten = 0;

  // PASS 1 — recompute (or purge) centroids, and FLUSH them, so pass 2's edge re-rank scans a
  // centroids table that already holds THIS tick's fresh vectors. Doing edges before the flush
  // would rank every artist against an empty/stale table (the probe subquery would find nothing).
  const centroidWrites: InStatement[] = [];
  const computed: string[] = [];

  for (const artistId of staleArtists) {
    // The artist's own vectors — a bounded per-artist pull (blobs, never JSON text).
    const vectorResult = await db.execute({
      args: [artistId],
      sql: `select t.embedding_blob as embedding_blob
            from track_artists ta
            join tracks t on t.track_id = ta.track_id
            where ta.artist_id = ? and t.embedding_blob is not null`,
    });

    const vectors: number[][] = [];

    for (const row of typedRows<ArtistVectorRow>(vectorResult.rows)) {
      // The driver hands a blob back as an ArrayBuffer, not a Uint8Array (embedding.ts).
      const embedding = readEmbeddingBlob(row.embedding_blob);

      if (embedding) {
        vectors.push(embedding);
      }
    }

    const mean = meanEmbedding(vectors);

    if (!mean) {
      // An orphan (its vectors were cleared between the candidate scan and now): purge it so it
      // stops ranking as anyone's neighbour, and drop its own edges.
      centroidWrites.push({
        args: [artistId],
        sql: `delete from artist_centroids where artist_id = ?`,
      });
      centroidWrites.push({
        args: [artistId],
        sql: `delete from artist_similar where artist_id = ?`,
      });
      centroidsRemoved += 1;
      continue;
    }

    // Store the mean the SOLE write form — `vector32()` converts the validated float array
    // server-side (embedding.ts / track-update.ts precedent; the Worker never encodes a vector).
    centroidWrites.push({
      args: [artistId, JSON.stringify(mean), vectors.length, corpus, stamp],
      sql: `insert into artist_centroids (artist_id, centroid_blob, vector_count, rank_corpus, computed_at)
            values (?, vector32(?), ?, ?, ?)
            on conflict(artist_id) do update set
              centroid_blob = excluded.centroid_blob,
              vector_count = excluded.vector_count,
              rank_corpus = excluded.rank_corpus,
              computed_at = excluded.computed_at`,
    });
    computed.push(artistId);
  }

  if (centroidWrites.length > 0) {
    await db.batch(centroidWrites, "write");
  }

  // PASS 2 — re-rank each recomputed artist's edges IN SQL against the now-fresh centroids table.
  const edgeWrites: InStatement[] = [];

  for (const artistId of computed) {
    // An exact `vector_distance_cos` scan of the (thousands-scale) centroids table; the target's
    // probe is supplied as the STORED blob via a subquery, so no vector crosses the wire and no
    // probe is ever bound as text (embedding.ts rule 2). Ties break on the neighbour's id, so a
    // tick is deterministic. Excludes the artist itself.
    const edgeResult = await db.execute({
      args: [artistId, artistId, ARTIST_SIMILAR_EDGES],
      sql: `select ac.artist_id as neighbour_id,
                   vector_distance_cos(
                     ac.centroid_blob,
                     (select centroid_blob from artist_centroids where artist_id = ?)
                   ) as dist
            from artist_centroids ac
            where ac.artist_id <> ?
            order by dist asc, ac.artist_id asc
            limit ?`,
    });
    const edges = typedRows<EdgeCandidateRow>(edgeResult.rows);

    // Replace the artist's edge set wholesale (the rank column is its PK second half, so a shrunk
    // neighbour set never leaves a stale high-rank row behind).
    edgeWrites.push({ args: [artistId], sql: `delete from artist_similar where artist_id = ?` });

    edges.forEach((edge, index) => {
      edgeWrites.push({
        args: [artistId, edge.neighbour_id, 1 - Number(edge.dist), index, corpus, stamp],
        sql: `insert into artist_similar
                (artist_id, neighbour_artist_id, similarity, rank, rank_corpus, computed_at)
              values (?, ?, ?, ?, ?, ?)`,
      });
      edgesWritten += 1;
    });
  }

  if (edgeWrites.length > 0) {
    await db.batch(edgeWrites, "write");
  }

  const centroidsComputed = computed.length;

  return {
    centroidsComputed,
    centroidsRemoved,
    corpus,
    edgesWritten,
    embeddedTracks,
    links,
    remaining: await countStaleArtists(corpus),
  };
}

// ── The read path (cheap: an ordered PK-prefix walk of the precomputed edges) ────────────

type NeighbourRow = {
  certified: number;
  image_url: string | null;
  name: string;
  slug: string;
};

/**
 * The artist page's "same sector" neighbours — now a cheap read of the PRECOMPUTED edges
 * (`artist_similar ⋈ artists`), no vector math on the request path. Walks the target's edges
 * in stored `rank` order (a PK-prefix scan) and joins each neighbour's public identity, up to
 * `limit`. Each neighbour carries `certified` — whether it has ≥1 finding — so the rail can
 * render a catalogue-only neighbour in the unlit register (never as a Finding).
 *
 * Returns `[]` when the artist has no edge rows yet (the `rank_artists` sweep has not reached
 * it, or it has no embedded track to rank from) — the rail simply does not render, the same
 * degraded behaviour the page-load version had for an un-embedded artist. Signature-stable: the
 * in-flight `get_similar_artists` tool reads this exact contract.
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
    args: [artistId, Math.max(0, limit)],
    sql: `select a.name as name, a.slug as slug, a.image_url as image_url,
                 exists(
                   select 1 from track_artists ta
                   join findings f on f.track_id = ta.track_id
                   where ta.artist_id = s.neighbour_artist_id
                 ) as certified
          from artist_similar s
          join artists a on a.id = s.neighbour_artist_id
          where s.artist_id = ?
          order by s.rank asc
          limit ?`,
  });

  return typedRows<NeighbourRow>(result.rows).map((row) => ({
    certified: Number(row.certified) === 1,
    imageUrl: row.image_url ?? undefined,
    name: row.name,
    slug: row.slug,
  }));
}
