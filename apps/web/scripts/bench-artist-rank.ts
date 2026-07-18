#!/usr/bin/env bun
/**
 * THROWAWAY HOSTED-SCALE BENCH — the ship gate for the similar-artists engine (D6). NOT a test, NOT
 * wired into CI.
 *
 * ── WHO RUNS THIS, AND WHEN ───────────────────────────────────────────────────
 * THE OPERATOR runs it ONCE, by hand, against a SCRATCH hosted Turso Cloud DB, as the pre-merge
 * gate for stored artist centroids + precomputed similar-artists edges. It CANNOT run in this repo's
 * CI or an agent's Bash session: it needs Turso Cloud credentials for a throwaway database, which
 * are operator-only. `turso dev` is NOT evidence here — docs/local-database.md "Local is not
 * production": the exact behaviours that decide whether a growing-table vector scan survives (the
 * blob-vs-text probe cliff, the scan plan) diverge between sqld and hosted, and the local one is
 * misleading in the DANGEROUS direction. An agent may (and this build did) self-check the SQL shapes
 * against local `turso dev` for CORRECTNESS only — never for a performance number.
 *
 * ── WHAT IT MEASURES ──────────────────────────────────────────────────────────
 *   A realistic archive: ~5k artists, ~25k embedded tracks (1024-d MuQ vectors stored as
 *   `F32_BLOB` via `vector32()`), each track credited to one artist, ~30% of artists certified
 *   (they carry a finding). Then the three shapes the engine runs, each with a p50 budget:
 *     (a) ONE SWEEP TICK's centroid recompute batch (`ARTIST_RANK_BATCH_SIZE` artists): read each
 *         artist's vectors, mean them in the isolate (`meanEmbedding`), upsert the centroid via
 *         `vector32()`. Batch work — budget ≤ a few seconds.
 *     (b) The SQL edge RE-RANK scan for ONE artist probe: `vector_distance_cos` over the whole
 *         (5k-row) `artist_centroids` table, the probe supplied as the STORED blob via a subquery.
 *         Batch work — budget ≤ a few seconds (it should be far under a second at this size).
 *     (c) The PAGE read (`getArtistNeighbours`): the ordered PK-prefix walk of one artist's stored
 *         edges joined to `artists` + the `certified` EXISTS. Request-path — budget < 100 ms.
 *   Plus `EXPLAIN QUERY PLAN` per shape, so the operator can SEE that (c) rides the `artist_similar`
 *   PK (never a table scan) and that (b) is the single intended `artist_centroids` scan.
 *
 * ── THE SHAPES UNDER TEST MIRROR THE REAL ONES ────────────────────────────────
 * (a) reuses the app's `meanEmbedding`/`readEmbeddingBlob`; (b) and (c) inline the exact SQL from
 * `lib/server/artist-dossier.ts` (`rankArtists` / `getArtistNeighbours`) — keep them in lockstep.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────────
 *   SCRATCH_TURSO_DATABASE_URL=libsql://<scratch>.turso.io \
 *   SCRATCH_TURSO_AUTH_TOKEN=<token> \
 *   bun run apps/web/scripts/bench-artist-rank.ts
 *
 * Optional env (seed volumes — dial down for a faster smoke, up for the real gate):
 *   BENCH_ARTISTS=5000   BENCH_TRACKS=25000   BENCH_ITERATIONS=12
 *
 * The operator CREATES the scratch DB before, and DESTROYS it after — this script only measures. It
 * NEVER points at `fluncle` or `fluncle-dev` (it refuses a URL containing either name as a guard).
 */
import { createClient } from "@libsql/client/web";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";

import {
  ARTIST_RANK_BATCH_SIZE,
  ARTIST_SIMILAR_EDGES,
  meanEmbedding,
} from "../src/lib/server/artist-dossier";
import { EMBEDDING_DIMS, readEmbeddingBlob } from "../src/lib/server/embedding";

/** The request-path shape (c) must come in under this; the batch shapes get a looser ceiling. */
const READ_BUDGET_MS = 100;
const BATCH_BUDGET_MS = 4_000;

function fail(message: string): never {
  console.error(`bench-artist-rank: ${message}`);
  process.exit(1);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];

  return raw ? Number.parseInt(raw, 10) : fallback;
}

const url = process.env.SCRATCH_TURSO_DATABASE_URL;
const authToken = process.env.SCRATCH_TURSO_AUTH_TOKEN;

if (!url || !authToken) {
  fail("set SCRATCH_TURSO_DATABASE_URL and SCRATCH_TURSO_AUTH_TOKEN (a THROWAWAY hosted DB)");
}

if (/fluncle(-dev)?\b/.test(url) || url.includes("127.0.0.1") || url.startsWith("file:")) {
  fail(`refusing to run against ${url} — use a SCRATCH hosted Turso DB, never prod/dev/local`);
}

const artistCount = envInt("BENCH_ARTISTS", 5_000);
const trackCount = envInt("BENCH_TRACKS", 25_000);
const iterations = envInt("BENCH_ITERATIONS", 12);

const client = createClient({ authToken, url });
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

// A tiny deterministic RNG (mulberry32) so every run seeds the SAME vectors — comparable numbers.
function makeRng(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state |= 0;
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A pseudo-random UNIT vector of `EMBEDDING_DIMS` floats — the MuQ shape, normalized like a real one. */
function randomUnitVector(rng: () => number): number[] {
  const vector = Array.from({ length: EMBEDDING_DIMS }, () => rng() * 2 - 1);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;

  return vector.map((value) => value / norm);
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));

  return sorted[index] ?? 0;
}

async function timeIt(run: () => Promise<unknown>): Promise<number> {
  const start = performance.now();

  await run();

  return performance.now() - start;
}

/** Seed `artistCount` artists; every 3rd one is CERTIFIED (carries a finding) so the read's EXISTS works. */
async function seedArtists(): Promise<void> {
  const now = new Date().toISOString();
  const chunk = 500;

  for (let start = 0; start < artistCount; start += chunk) {
    const end = Math.min(artistCount, start + chunk);
    const statements = [];

    for (let index = start; index < end; index += 1) {
      const id = `ar-${index}`;

      statements.push({
        args: [id, `Artist ${index}`, id, `https://i.scdn.co/image/${id}`, now, now],
        sql: `insert into artists (id, name, slug, image_url, created_at, updated_at)
              values (?, ?, ?, ?, ?, ?)`,
      });
    }

    await client.batch(statements, "write");
    process.stdout.write(`\r  artists ${end}/${artistCount}`);
  }

  process.stdout.write("\n");
}

/**
 * Seed `trackCount` embedded tracks: each is a `tracks` row with a `vector32()` embedding, credited
 * to one artist (round-robin). Every 3rd track is a certified FINDING (a `findings` row too), so the
 * read's `certified` EXISTS has rows to find. Vectors are the seeded RNG's, so the scan cost is real.
 */
async function seedTracks(): Promise<void> {
  const rng = makeRng(0x5f_37_59_df);
  const now = new Date().toISOString();
  const chunk = 200;

  for (let start = 0; start < trackCount; start += chunk) {
    const end = Math.min(trackCount, start + chunk);
    const statements = [];

    for (let index = start; index < end; index += 1) {
      const trackId = `tr-${index}`;
      const artistId = `ar-${index % artistCount}`;
      const vector = JSON.stringify(randomUnitVector(rng));

      statements.push(
        {
          args: [trackId, `Track ${index}`, `["Artist ${index % artistCount}"]`, vector],
          sql: `insert into tracks
            (track_id, title, artists_json, spotify_uri, spotify_url, duration_ms, embedding_blob)
            values (?, ?, ?, 'spotify:track:x', 'https://open.spotify.com/track/x', 270000, vector32(?))`,
        },
        {
          args: [trackId, artistId],
          sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 1)`,
        },
      );

      if (index % 3 === 0) {
        statements.push({
          // The full index keeps log_id unique past 1000 findings (a %1000 fold collided at 3000).
          args: [trackId, `${String(index).padStart(6, "0")}.7.1A`, now],
          sql: `insert into findings (track_id, log_id, added_at) values (?, ?, ?)`,
        });
      }
    }

    await client.batch(statements, "write");
    process.stdout.write(`\r  tracks ${end}/${trackCount}`);
  }

  process.stdout.write("\n");
}

// ── The shapes under test (b)/(c) — the EXACT SQL from lib/server/artist-dossier.ts ──────────
const EDGE_RERANK_SQL = `select ac.artist_id as neighbour_id,
             vector_distance_cos(
               ac.centroid_blob,
               (select centroid_blob from artist_centroids where artist_id = ?)
             ) as dist
      from artist_centroids ac
      where ac.artist_id <> ?
      order by dist asc, ac.artist_id asc
      limit ?`;

const NEIGHBOURS_READ_SQL = `select a.name as name, a.slug as slug, a.image_url as image_url,
             exists(
               select 1 from track_artists ta
               join findings f on f.track_id = ta.track_id
               where ta.artist_id = s.neighbour_artist_id
             ) as certified
      from artist_similar s
      join artists a on a.id = s.neighbour_artist_id
      where s.artist_id = ?
      order by s.rank asc
      limit ?`;

/** Compute + store a centroid for every artist by running ONE full sweep-shaped pass, in batches. */
async function seedCentroidsAndEdges(): Promise<void> {
  const now = new Date().toISOString();

  // Centroids: read each artist's vectors, mean them, upsert — the real recompute path.
  for (let start = 0; start < artistCount; start += ARTIST_RANK_BATCH_SIZE) {
    const end = Math.min(artistCount, start + ARTIST_RANK_BATCH_SIZE);
    const writes = [];

    for (let index = start; index < end; index += 1) {
      const mean = await computeCentroid(`ar-${index}`);

      if (mean) {
        writes.push({
          args: [`ar-${index}`, JSON.stringify(mean), now],
          sql: `insert into artist_centroids (artist_id, centroid_blob, vector_count, rank_corpus, computed_at)
                values (?, vector32(?), 1, 'bench', ?)`,
        });
      }
    }

    if (writes.length > 0) {
      await client.batch(writes, "write");
    }

    process.stdout.write(`\r  centroids ${end}/${artistCount}`);
  }

  process.stdout.write("\n");

  // Edges: rank each artist's top-K in SQL, store them — so shape (c) reads a populated table.
  for (let start = 0; start < artistCount; start += ARTIST_RANK_BATCH_SIZE) {
    const end = Math.min(artistCount, start + ARTIST_RANK_BATCH_SIZE);
    const writes = [];

    for (let index = start; index < end; index += 1) {
      const artistId = `ar-${index}`;
      const edges = await client.execute({
        args: [artistId, artistId, ARTIST_SIMILAR_EDGES],
        sql: EDGE_RERANK_SQL,
      });

      edges.rows.forEach((row, rank) => {
        writes.push({
          args: [artistId, cell(row.neighbour_id), 1 - Number(row.dist), rank, now],
          sql: `insert into artist_similar
                  (artist_id, neighbour_artist_id, similarity, rank, rank_corpus, computed_at)
                values (?, ?, ?, ?, 'bench', ?)`,
        });
      });
    }

    if (writes.length > 0) {
      await client.batch(writes, "write");
    }

    process.stdout.write(`\r  edges ${end}/${artistCount}`);
  }

  process.stdout.write("\n");
}

/** Read one artist's track vectors, decode + mean them — the isolate half of a centroid recompute. */
async function computeCentroid(artistId: string): Promise<number[] | null> {
  const result = await client.execute({
    args: [artistId],
    sql: `select t.embedding_blob as embedding_blob
          from track_artists ta
          join tracks t on t.track_id = ta.track_id
          where ta.artist_id = ? and t.embedding_blob is not null`,
  });

  const vectors: number[][] = [];

  for (const row of result.rows) {
    const vector = readEmbeddingBlob(row.embedding_blob);

    if (vector) {
      vectors.push(vector);
    }
  }

  return meanEmbedding(vectors);
}

/** ONE sweep tick's centroid recompute batch: `ARTIST_RANK_BATCH_SIZE` artists read + meaned + upserted. */
async function centroidRecomputeBatch(offset: number): Promise<void> {
  const now = new Date().toISOString();
  const writes = [];

  for (let index = offset; index < offset + ARTIST_RANK_BATCH_SIZE; index += 1) {
    const mean = await computeCentroid(`ar-${index % artistCount}`);

    if (mean) {
      writes.push({
        args: [`ar-${index % artistCount}`, JSON.stringify(mean), now],
        sql: `insert into artist_centroids (artist_id, centroid_blob, vector_count, rank_corpus, computed_at)
              values (?, vector32(?), 1, 'bench-tick', ?)
              on conflict(artist_id) do update set centroid_blob = excluded.centroid_blob,
                rank_corpus = excluded.rank_corpus, computed_at = excluded.computed_at`,
      });
    }
  }

  if (writes.length > 0) {
    await client.batch(writes, "write");
  }
}

/** A libSQL cell → string, for the EXPLAIN dump. */
function cell(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
}

async function explain(sql: string, args: (number | string)[]): Promise<string> {
  const result = await client.execute({ args, sql: `explain query plan ${sql}` });

  return result.rows.map((row) => cell(row.detail)).join("\n      ");
}

async function main(): Promise<void> {
  console.log("bench-artist-rank — applying migrations to the scratch DB…");
  await migrate(drizzle(client), { migrationsFolder });

  console.log(`Seeding ${artistCount} artists…`);
  await seedArtists();
  console.log(`Seeding ${trackCount} embedded tracks…`);
  await seedTracks();
  console.log("Computing centroids + edges (the initial full drain)…");
  await seedCentroidsAndEdges();

  const probe = "ar-1";
  let allWithinBudget = true;

  console.log("\n── p50 per shape ────────────────────────────────────────────────");

  // (a) One tick's centroid recompute batch.
  const recomputeSamples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    recomputeSamples.push(
      await timeIt(() =>
        centroidRecomputeBatch((iteration * ARTIST_RANK_BATCH_SIZE) % artistCount),
      ),
    );
  }
  const recomputeP50 = percentile(recomputeSamples, 50);
  const recomputeOk = recomputeP50 < BATCH_BUDGET_MS;
  allWithinBudget &&= recomputeOk;
  console.log(
    `  (a) centroid recompute (${ARTIST_RANK_BATCH_SIZE})   p50 ${recomputeP50.toFixed(1).padStart(8)} ms  ${
      recomputeOk ? "✓ under" : "✗ OVER"
    } ${BATCH_BUDGET_MS} ms`,
  );

  // (b) The SQL edge re-rank scan for one artist probe.
  const rerankSamples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    rerankSamples.push(
      await timeIt(() =>
        client.execute({ args: [probe, probe, ARTIST_SIMILAR_EDGES], sql: EDGE_RERANK_SQL }),
      ),
    );
  }
  const rerankP50 = percentile(rerankSamples, 50);
  const rerankOk = rerankP50 < BATCH_BUDGET_MS;
  allWithinBudget &&= rerankOk;
  console.log(
    `  (b) edge re-rank scan (1 probe)     p50 ${rerankP50.toFixed(1).padStart(8)} ms  ${
      rerankOk ? "✓ under" : "✗ OVER"
    } ${BATCH_BUDGET_MS} ms`,
  );

  // (c) The page's getArtistNeighbours edge read.
  const readSamples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    readSamples.push(
      await timeIt(() => client.execute({ args: [probe, 4], sql: NEIGHBOURS_READ_SQL })),
    );
  }
  const readP50 = percentile(readSamples, 50);
  const readOk = readP50 < READ_BUDGET_MS;
  allWithinBudget &&= readOk;
  console.log(
    `  (c) getArtistNeighbours read        p50 ${readP50.toFixed(1).padStart(8)} ms  ${
      readOk ? "✓ under" : "✗ OVER"
    } ${READ_BUDGET_MS} ms`,
  );

  console.log("\n── EXPLAIN QUERY PLAN ───────────────────────────────────────────");
  const rerankPlan = await explain(EDGE_RERANK_SQL, [probe, probe, ARTIST_SIMILAR_EDGES]);
  console.log(`  (b) edge re-rank:\n      ${rerankPlan}\n`);
  const readPlan = await explain(NEIGHBOURS_READ_SQL, [probe, 4]);
  console.log(`  (c) neighbours read:\n      ${readPlan}`);
  // The read's primary walk must ride the artist_similar PK (a range scan), never a full table scan.
  const readRidesPk = /USING (PRIMARY KEY|INDEX)/.test(readPlan);
  const readFullScan = /SCAN artist_similar\b(?! USING)/.test(readPlan);
  console.log(
    `  → ${readRidesPk ? "rides an index" : "NOT on an index"}${
      readFullScan ? " — WARNING: a full SCAN artist_similar appears" : ""
    }\n`,
  );

  console.log(
    allWithinBudget
      ? "SHIP GATE: PASS — every shape's p50 under budget."
      : "SHIP GATE: FAIL — a shape blew its budget. Do NOT merge on these numbers.",
  );
  process.exit(allWithinBudget ? 0 : 1);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
