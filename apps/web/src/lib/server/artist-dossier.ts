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
import {
  type EmbeddingCandidate,
  readEmbeddingBlob,
  rankBySimilarity,
  toVectorProbe,
} from "./embedding";
import { bestArtistAvatarUrl } from "../media";
import { coarseRescoreRank, encodeF8Probe } from "./vector-search";

/** How many "same sector" neighbours the artist page shows (top-N, self excluded). */
export const ARTIST_NEIGHBOURS_LIMIT = 4;

/**
 * How many precomputed edges the sweep stores per artist. The rail renders
 * {@link ARTIST_NEIGHBOURS_LIMIT} (4); the extra headroom is for the MCP
 * `get_similar_artists` tool, which reads the same `artist_similar` table.
 */
export const ARTIST_SIMILAR_EDGES = 8;

/**
 * How many stale/orphan artists one `rank_artists` tick recomputes — the LOAD-BEARING knob that
 * keeps a tick inside the box timer's 600 s window. The tick's cost is dominated by pass 2, where
 * each recomputed artist triggers one exact `vector_distance_cos` scan of the whole
 * `artist_centroids` table (there is no ANN index on Turso — ratified; see the sweep's SCALING
 * ENVELOPE note). At ~5k artists a probe is ≈ 2 s, so a full 50-artist tick is ≈ 100 s of scans —
 * comfortable headroom under 600 s, and room for the table to grow. In STEADY STATE only the
 * handful of artists whose discography changed that day are stale, so a daily tick is a fraction
 * of this. A cold first drain of the whole archive is many ticks (operator runs the CLI in a loop);
 * `--limit` raises it while the table is small and lowers it as it grows past ~10k.
 */
export const ARTIST_RANK_BATCH_SIZE = 50;

/**
 * How many artists' vectors/writes ride ONE round trip within a tick. Pass 1 fetches a chunk's
 * vectors in a single `IN (…)` query (a chunk is bounded, so this is not the pull-the-whole-table
 * trap — it is the blessed bounded artist-dossier-means read) and flushes the chunk's centroid
 * writes in one `client.batch`; the edge writes flush the same way. Keeps each payload small.
 */
export const ARTIST_RANK_CHUNK = 25;

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

// ── The multi-artist "sounds like these" ranking (browse-by-feel on /artists) ─────────────

/** The most artists a "sounds like these" compare accepts — the isolate averages this many stored
 *  centroids into one probe (a bounded read), so it never grows into a whole-corpus pull. */
export const MAX_SIMILAR_ARTISTS_INPUT = 6;

/** How many neighbours the multi-artist "sounds like these" results return (the tile grid + the API). */
export const SIMILAR_ARTISTS_LIMIT = 12;

/**
 * Rank the artists sonically nearest to the AVERAGE of several SELECTED artists' mean embeddings —
 * the pure, in-isolate expression of the multi-artist "sounds like these" scan
 * ({@link listSimilarArtistNeighbours} does exactly this IN SQL against `artist_centroids`). The
 * probe is the mean of the selected artists' centroids (each already a mean over that artist's own
 * tracks), so every selected artist weighs EQUALLY regardless of catalogue depth. The selected
 * artists are excluded from their own results. Returns [] when no selected artist has a vector to
 * position from — never throws. Deterministic: ties break toward the earlier candidate via
 * `rankBySimilarity`, so a fixed group order yields a fixed result. The `rankSimilarArtists` twin,
 * lifted from one target to several.
 */
export function rankSimilarToArtists(
  selectedArtistIds: string[],
  groups: ArtistEmbeddingGroup[],
  limit: number,
): ArtistIdentity[] {
  const selected = new Set(selectedArtistIds);
  const selectedMeans: number[][] = [];

  for (const group of groups) {
    if (!selected.has(group.artistId)) {
      continue;
    }

    const mean = meanEmbedding(group.vectors);

    if (mean) {
      selectedMeans.push(mean);
    }
  }

  // The probe is the mean OF the selected artists' means — equal weight per artist, not per track.
  const target = meanEmbedding(selectedMeans);

  if (!target) {
    return [];
  }

  const candidates: EmbeddingCandidate<ArtistIdentity>[] = [];

  for (const group of groups) {
    if (selected.has(group.artistId)) {
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
 * The PER-ARTIST staleness fingerprint stored on a centroid —
 * `"<version>:<the artist's embedded-track count>"`. It is deliberately PER-ARTIST, not
 * global: a centroid's VALUE only moves when THAT artist's own embedded-track set changes
 * (a track of theirs gains/loses its embedding, or an artist↔track link is added/removed),
 * so keying staleness on the artist's own count means a new finding re-stales only the few
 * artists it credits — not all ~5k. (A global "<embedded tracks>:<links>" fingerprint, the
 * `rank_catalogue` shape, would re-stale EVERY centroid on any archive change; correct there
 * because a catalogue row's ranking against the findings genuinely moves for all rows, wrong
 * here because an artist's mean does not.) Steady state is then the handful of artists whose
 * discography changed that day, and a full re-rank only happens on a cold start or a
 * {@link ARTIST_RANK_LOGIC_VERSION} bump.
 *
 * The count catches the dominant cases (embed/un-embed a track, add/remove a link). A RE-EMBED
 * of an existing track — same count, new vector — is the one change the count misses; it is
 * rare (a wrong-audio re-capture) and is swept up by the next count change or a logic-version
 * bump. Stamped from the DB ROW COUNT, never the decoded-vector count, so a single malformed
 * blob can never leave an artist perpetually stale.
 */
export function artistCentroidFingerprint(embeddedTrackCount: number): string {
  return `${ARTIST_RANK_LOGIC_VERSION}:${embeddedTrackCount}`;
}

// ── The sweep (`rank_artists`) ──────────────────────────────────────────────────────────

/** One `rank_artists` tick's outcome — the JSON summary line a `--no-agent` cron prints. */
export type RankArtistsSummary = {
  /** Artist centroids recomputed this tick (a mean re-folded + its top-K edges re-ranked). */
  centroidsComputed: number;
  /** Orphan centroids purged this tick (the artist lost every embedded track). */
  centroidsRemoved: number;
  /** Distinct edge rows written this tick (`centroidsComputed × ≤K`). */
  edgesWritten: number;
  /** The staleness-logic version this tick ran (a bump forces a full self-healing re-rank). */
  logicVersion: string;
  /** Stale/orphan artists still pending after this tick — the "run me again" signal. */
  remaining: number;
};

type ArtistVectorRow = { artist_id: string; embedding_blob: unknown };
type StaleArtistRow = { artist_id: string };
type EdgeCandidateRow = { dist: number; neighbour_id: string };

// The stale/orphan candidate set, shared by the sweep and `countStaleArtists`. Two arms, keyed on
// the PER-ARTIST fingerprint (`artistCentroidFingerprint`), so only artists whose OWN embedded-track
// set drifted are picked:
//   1. STALE — an artist crediting ≥1 embedded track whose centroid is missing OR whose stored
//      fingerprint disagrees with `<version>:<their live embedded-track count>`.
//   2. ORPHAN — a centroid whose artist no longer credits ANY embedded track (its vectors were
//      cleared, e.g. a wrong-audio flag) — it must be purged so it stops ranking as a neighbour.
// The version literal is a trusted constant (never user input), so it interpolates safely into the
// `<>` comparison; the scan takes no bind args. The GROUP BY is one indexed aggregate over the
// embedded tracks — run once per tick, not per artist.
const STALE_ARTISTS_INNER = `select live.artist_id as artist_id
            from (
              select ta.artist_id as artist_id, count(*) as n
              from track_artists ta
              join tracks t on t.track_id = ta.track_id
              where t.embedding_blob is not null
              group by ta.artist_id
            ) live
            left join artist_centroids ac on ac.artist_id = live.artist_id
            where ac.artist_id is null
               or ac.rank_corpus <> ('${ARTIST_RANK_LOGIC_VERSION}:' || live.n)
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

/** Count the stale/orphan artists still pending — the `remaining` gauge. */
async function countStaleArtists(): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select count(*) as n from (${STALE_ARTISTS_INNER})`,
  });

  return Number(typedRows<{ n: number }>(result.rows)[0]?.n ?? 0);
}

/** Split `items` into consecutive chunks of at most `size` (bounds each round trip's payload). */
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }

  return chunks;
}

// The edge re-rank probe — one exact `vector_distance_cos` scan of `artist_centroids` for a single
// target, the probe supplied as the STORED blob via a subquery so no vector crosses the wire and no
// probe is ever bound as text (embedding.ts rule 2). Ties break on the neighbour's id, so a tick is
// deterministic. This is `rank_artists`'s heaviest statement and its cost grows LINEARLY with the
// centroid count — see the SCALING ENVELOPE note on `rankArtists`.
const EDGE_RERANK_SQL = `select ac.artist_id as neighbour_id,
                   vector_distance_cos(
                     ac.centroid_blob,
                     (select centroid_blob from artist_centroids where artist_id = ?)
                   ) as dist
            from artist_centroids ac
            where ac.artist_id <> ?
            order by dist asc, ac.artist_id asc
            limit ?`;

/**
 * One tick of the similar-artists precompute sweep — the artist-graph sibling of
 * `rankCatalogue` (docs/the-ear.md). It recomputes up to `limit` STALE centroids (each the
 * MEAN over all the artist's embedded tracks — findings AND catalogue) and re-ranks each
 * one's top-{@link ARTIST_SIMILAR_EDGES} sonic neighbours IN SQL, then purges any ORPHAN
 * centroid whose artist lost every embedded track.
 *
 * The tick, in order:
 *   1. Take up to `limit` stale/orphan artists (`STALE_ARTISTS_PAGE`), oldest-id first. Staleness
 *      is PER-ARTIST (`artistCentroidFingerprint`): only artists whose OWN embedded-track set
 *      drifted are picked, so a new finding re-stales the few artists it credits, not the archive.
 *   2. PASS 1 — recompute centroids in bounded CHUNKS, both round trips batched: one `IN (…)` query
 *      fetches a chunk's vectors (blobs, never text), and one `client.batch` flushes the chunk's
 *      centroid upserts (mean stored via `vector32()`, the sole write form) + orphan deletes. Pass 1
 *      is fully flushed before pass 2, so the edge re-rank scans a centroids table already holding
 *      this tick's fresh vectors. The fingerprint is stamped from the DB ROW COUNT (not the decoded
 *      count) so a malformed blob can't leave an artist perpetually stale.
 *   3. PASS 2 — re-rank each recomputed artist's edges. The scans stay PER-ARTIST reads (each a
 *      bounded ~O(centroid-count) scan) rather than one giant batched statement, so no single query
 *      runs unbounded; the edge WRITES are batched per chunk to collapse their round trips. The
 *      LIMIT is what bounds pass 2 — see the envelope note.
 *
 * ── SCALING ENVELOPE (read before raising the default) ────────────────────────────────────────
 * Pass 2's per-probe cost grows LINEARLY with the centroid count: the exact `vector_distance_cos`
 * scan drags every centroid blob (≈ 4 KB each) once per probe — there is NO ANN index on Turso, by
 * ratified decision (docs/local-database.md), so this full scan is inherent to exact centroid
 * ranking. Measured ≈ 2 s/probe at ~5k artists (hosted). The `limit` knob keeps a tick inside the
 * 600 s box timer (a 50-artist tick ≈ 100 s at 5k); steady state is a fraction of one tick (only the
 * day's changed artists are stale). A cold whole-archive drain is `ceil(artists / limit)` ticks,
 * driven by the operator looping the CLI. When the centroid table outgrows the exact scan (roughly
 * as it passes ~10–20k artists and a single tick stops fitting the timer at a useful limit), the
 * recorded escape hatch is the roadmap's Cloudflare Vectorize spike (an ANN index for the artist
 * centroids); until then this exact scan is correct and the limit is the throttle.
 *
 * SELF-HEALING + eventual-consistency: staleness is the per-artist fingerprint, so an archive change
 * re-ranks the affected artists over later ticks. An early tick may rank an artist against a
 * neighbour whose own centroid is about to refresh, but a centroid's VALUE only moves when that
 * neighbour's embedded-track set changed, and the next change re-ranks the drift — the accepted
 * shape for a browse-adjacent rail. Idempotent and resume-safe: a crash mid-tick leaves the
 * un-stamped artists stale for the next tick; a re-run on a settled graph is a no-op. `now` is
 * injected so the ranking logic carries no `Date.now`.
 */
export async function rankArtists(
  limit = ARTIST_RANK_BATCH_SIZE,
  now: () => string = () => new Date().toISOString(),
): Promise<RankArtistsSummary> {
  const db = await getDb();
  const bounded = Math.max(0, limit);

  const staleResult = await db.execute({ args: [bounded], sql: STALE_ARTISTS_PAGE });
  const staleArtists = typedRows<StaleArtistRow>(staleResult.rows).map((row) => row.artist_id);

  if (staleArtists.length === 0) {
    // `remaining` is COUNTED, never assumed zero (a `limit` of 0 idles with rows still stale).
    return {
      centroidsComputed: 0,
      centroidsRemoved: 0,
      edgesWritten: 0,
      logicVersion: ARTIST_RANK_LOGIC_VERSION,
      remaining: await countStaleArtists(),
    };
  }

  const stamp = now();
  let centroidsRemoved = 0;
  let edgesWritten = 0;
  // Each recomputed artist carries the fingerprint it was stamped with, so pass 2's edge rows get
  // the same value (the schema keeps edge + centroid `rank_corpus` in lockstep).
  const computed: { artistId: string; fingerprint: string }[] = [];

  // ── PASS 1 — recompute (or purge) centroids in bounded chunks, batching BOTH round trips ──────
  for (const artistChunk of chunk(staleArtists, ARTIST_RANK_CHUNK)) {
    const placeholders = artistChunk.map(() => "?").join(", ");
    // One IN-query for the whole chunk's vectors — the (a) round-trip fix. Bounded by the chunk,
    // so this is the blessed bounded artist-dossier-means read, not the pull-the-whole-table trap.
    const vectorResult = await db.execute({
      args: artistChunk,
      sql: `select ta.artist_id as artist_id, t.embedding_blob as embedding_blob
            from track_artists ta
            join tracks t on t.track_id = ta.track_id
            where ta.artist_id in (${placeholders}) and t.embedding_blob is not null`,
    });

    // Group each artist's vectors + count its embedded-track ROWS (the fingerprint's count).
    const grouped = new Map<string, { count: number; vectors: number[][] }>();

    for (const artistId of artistChunk) {
      grouped.set(artistId, { count: 0, vectors: [] });
    }

    for (const row of typedRows<ArtistVectorRow>(vectorResult.rows)) {
      const entry = grouped.get(row.artist_id);

      if (!entry) {
        continue;
      }

      // The DB row count is the artist's embedded-track count; decode is best-effort on top of it.
      entry.count += 1;
      // The driver hands a blob back as an ArrayBuffer, not a Uint8Array (embedding.ts).
      const embedding = readEmbeddingBlob(row.embedding_blob);

      if (embedding) {
        entry.vectors.push(embedding);
      }
    }

    const centroidWrites: InStatement[] = [];

    for (const artistId of artistChunk) {
      const entry = grouped.get(artistId);
      const mean = entry ? meanEmbedding(entry.vectors) : null;

      if (!entry || entry.count === 0 || !mean) {
        // An orphan (no embedded track now): purge its centroid AND every edge it touches — its
        // OWN edges, and the edges POINTING TO it (via the `neighbour_artist_id` index), so a
        // purged artist vanishes from every rail immediately rather than lingering as a stale
        // neighbour on artists that per-artist staleness would not otherwise re-rank.
        centroidWrites.push({
          args: [artistId],
          sql: `delete from artist_centroids where artist_id = ?`,
        });
        centroidWrites.push({
          args: [artistId],
          sql: `delete from artist_similar where artist_id = ?`,
        });
        centroidWrites.push({
          args: [artistId],
          sql: `delete from artist_similar where neighbour_artist_id = ?`,
        });
        centroidsRemoved += 1;
        continue;
      }

      // Stamp the fingerprint from the DB ROW COUNT so a lone malformed blob never loops the artist.
      const fingerprint = artistCentroidFingerprint(entry.count);

      // Store the mean via `vector32()` (server-side, the Worker never encodes a vector), AND its
      // int8 COARSE-SCAN sibling via `vector8()` in LOCKSTEP off the same JSON — the `centroid_f8`
      // twin of `embedding_f8` (RFC vector-search-scale, slice A). The `/artists?like=` scan
      // coarse-ranks `centroid_f8` and rescores against `centroid_blob`, so the two must never
      // diverge; writing both here keeps a freshly-ranked centroid coarse-scannable at once.
      centroidWrites.push({
        args: [
          artistId,
          JSON.stringify(mean),
          JSON.stringify(mean),
          entry.count,
          fingerprint,
          stamp,
        ],
        sql: `insert into artist_centroids (artist_id, centroid_blob, centroid_f8, vector_count, rank_corpus, computed_at)
              values (?, vector32(?), vector8(?), ?, ?, ?)
              on conflict(artist_id) do update set
                centroid_blob = excluded.centroid_blob,
                centroid_f8 = excluded.centroid_f8,
                vector_count = excluded.vector_count,
                rank_corpus = excluded.rank_corpus,
                computed_at = excluded.computed_at`,
      });
      computed.push({ artistId, fingerprint });
    }

    if (centroidWrites.length > 0) {
      await db.batch(centroidWrites, "write");
    }
  }

  // ── PASS 2 — re-rank each recomputed artist's edges against the now-fresh centroids table ─────
  for (const computedChunk of chunk(computed, ARTIST_RANK_CHUNK)) {
    const edgeWrites: InStatement[] = [];

    for (const { artistId, fingerprint } of computedChunk) {
      // A bounded per-artist scan (NOT batched into one giant statement — the scans stay separate so
      // no single query runs unbounded; the WRITES below are the batched part).
      const edgeResult = await db.execute({
        args: [artistId, artistId, ARTIST_SIMILAR_EDGES],
        sql: EDGE_RERANK_SQL,
      });
      const edges = typedRows<EdgeCandidateRow>(edgeResult.rows);

      // Replace the artist's edge set wholesale (the rank column is its PK second half, so a shrunk
      // neighbour set never leaves a stale high-rank row behind).
      edgeWrites.push({ args: [artistId], sql: `delete from artist_similar where artist_id = ?` });

      edges.forEach((edge, index) => {
        edgeWrites.push({
          args: [artistId, edge.neighbour_id, 1 - Number(edge.dist), index, fingerprint, stamp],
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
  }

  return {
    centroidsComputed: computed.length,
    centroidsRemoved,
    edgesWritten,
    logicVersion: ARTIST_RANK_LOGIC_VERSION,
    remaining: await countStaleArtists(),
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

// ── The multi-artist "sounds like these" read (the exact scan, one live probe) ────────────

/** One "sounds like these" result — the ranked artist IDENTITY only; the caller adds counts/certified
 *  off the shared hub gate, so the tier stays single-sourced (see artists.ts's two projections). */
export type SimilarArtistNeighbour = {
  artistId: string;
  imageUrl: string | undefined;
  name: string;
  slug: string;
};

type SimilarArtistRow = {
  artist_id: string;
  image_key: string | null;
  image_state: string | null;
  image_updated_at: string | null;
  image_url: string | null;
  name: string;
  slug: string;
};

/**
 * The artists sonically nearest to a SET of selected artists — the "sounds like these" multi-select
 * on `/artists`. Two bounded reads:
 *
 *   1. Read the ≤{@link MAX_SIMILAR_ARTISTS_INPUT} selected artists' STORED centroids (an indexed
 *      `slug in (…)` join to `artist_centroids`), decode them, and average them in the isolate into
 *      one probe (the mean OF means — each selected artist weighs equally). A slug with no centroid
 *      simply does not contribute; if none do, there is nothing to rank from and the result is empty.
 *   2. The exact `vector_distance_cos` scan of `artist_centroids` with that averaged probe bound as a
 *      RAW float32 BLOB (embedding.ts rule 2 — a text probe is the measured 14× hosted cliff), the
 *      selected artists excluded. This is the SAME scan SHAPE the hosted-proven `rank_artists` sweep
 *      runs per tick ({@link EDGE_RERANK_SQL}); the only differences are that the probe is a live
 *      averaged BLOB rather than a stored single centroid, and the exclusion is a set rather than one
 *      id. No ANN index (ratified — docs/local-database.md); the exact scan is ≈ 2 s at ~5k artists.
 *
 * Returns the ranked identity (name/slug/avatar); `certified` + the counts are the CALLER's job, off
 * the shared hub gate, so the lit/unlit tier here agrees with the rest of the page. Never throws.
 */
export async function listSimilarArtistNeighbours(
  slugs: string[],
  limit: number,
): Promise<SimilarArtistNeighbour[]> {
  const cleaned = [...new Set(slugs.map((slug) => slug.trim()).filter(Boolean))].slice(
    0,
    MAX_SIMILAR_ARTISTS_INPUT,
  );

  if (cleaned.length === 0 || limit <= 0) {
    return [];
  }

  const db = await getDb();
  const selectedPlaceholders = cleaned.map(() => "?").join(", ");
  const selectedResult = await db.execute({
    args: cleaned,
    sql: `select a.id as artist_id, ac.centroid_blob as centroid_blob
          from artists a
          join artist_centroids ac on ac.artist_id = a.id
          where a.slug in (${selectedPlaceholders})`,
  });
  const selected = typedRows<{ artist_id: string; centroid_blob: unknown }>(selectedResult.rows);

  if (selected.length === 0) {
    return [];
  }

  const vectors: number[][] = [];

  for (const row of selected) {
    const vector = readEmbeddingBlob(row.centroid_blob);

    if (vector) {
      vectors.push(vector);
    }
  }

  const probe = meanEmbedding(vectors);

  if (!probe) {
    return [];
  }

  const selectedIds = selected.map((row) => row.artist_id);
  const idPlaceholders = selectedIds.map(() => "?").join(", ");
  const where = `ac.artist_id not in (${idPlaceholders})`;

  // The two-pass scan (lib/server/vector-search.ts): coarse-rank the compact `centroid_f8` codes,
  // then rescore the winners against the exact `centroid_blob`. The averaged probe is a LIVE vector
  // (the mean of the selected centroids), so its int8 coarse form is encoded once (`SELECT vector8`)
  // — a stored code cannot serve here. A defensive encode miss falls back to the exact centroid scan.
  const coarseProbe = await encodeF8Probe(db, probe);
  const ranked = coarseProbe
    ? await coarseRescoreRank(db, {
        coarseFrom: "artist_centroids ac",
        coarseProbes: [coarseProbe],
        exactProbes: [toVectorProbe(probe)],
        f32Column: "ac.centroid_blob",
        f8Column: "ac.centroid_f8",
        idColumn: "ac.artist_id",
        k: Math.max(0, limit),
        rescoreFrom: "artist_centroids ac",
        where,
        whereArgs: selectedIds,
      })
    : await exactCentroidScan(db, probe, where, selectedIds, Math.max(0, limit));

  if (ranked.length === 0) {
    return [];
  }

  // Hydrate the ranked artist ids into their public identity, preserving the exact rank order.
  const ids = ranked.map((row) => row.id);
  const hydratePlaceholders = ids.map(() => "?").join(", ");
  const hydrated = await db.execute({
    args: ids,
    sql: `select a.id as artist_id, a.slug as slug, a.name as name, a.image_url as image_url,
                 a.image_key as image_key, a.image_state as image_state, a.image_updated_at as image_updated_at
          from artists a
          where a.id in (${hydratePlaceholders})`,
  });
  const byId = new Map(
    typedRows<SimilarArtistRow>(hydrated.rows).map((row) => [row.artist_id, row]),
  );

  return ids.flatMap((id) => {
    const row = byId.get(id);

    return row
      ? [
          {
            artistId: row.artist_id,
            imageUrl: bestArtistAvatarUrl({
              imageKey: row.image_key,
              imageState: row.image_state,
              imageUpdatedAt: row.image_updated_at,
              imageUrl: row.image_url,
            }),
            name: row.name,
            slug: row.slug,
          },
        ]
      : [];
  });
}

/**
 * The exact single-pass float32 centroid scan — the DEGRADATION path for
 * {@link listSimilarArtistNeighbours} if the int8 coarse probe cannot be encoded (a libSQL
 * `vector8` failure; effectively never). Returns `(id, distance)` in the `coarseRescoreRank` shape.
 */
async function exactCentroidScan(
  db: Awaited<ReturnType<typeof getDb>>,
  probe: number[],
  where: string,
  selectedIds: string[],
  limit: number,
): Promise<{ distance: number; id: string }[]> {
  const result = await db.execute({
    args: [toVectorProbe(probe), ...selectedIds, limit],
    sql: `select ac.artist_id as id, vector_distance_cos(ac.centroid_blob, ?) as dist
          from artist_centroids ac
          where ${where}
          order by dist asc, ac.artist_id asc
          limit ?`,
  });

  return typedRows<{ dist: number; id: string }>(result.rows).map((row) => ({
    distance: row.dist,
    id: row.id,
  }));
}
