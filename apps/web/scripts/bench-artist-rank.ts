#!/usr/bin/env bun

import { createClient } from "@libsql/client/web";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";

import {
  ARTIST_NEIGHBOURS_SQL,
  ARTIST_RANK_BATCH_SIZE,
  ARTIST_RANK_CHUNK,
  ARTIST_SIMILAR_EDGES,
  meanEmbedding,
} from "../src/lib/server/artist-dossier";
import { EMBEDDING_DIMS, readEmbeddingBlob } from "../src/lib/server/embedding";
import { backfillHubCounts } from "./backfill-hub-counts";

const READ_BUDGET_MS = 100;

const RECOMPUTE_BUDGET_MS = 4_000;
const RECOMPUTE_N = 100;

const TICK_TIMER_MS = 600_000;

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

const client = createClient({ authToken, concurrency: REMOTE_DB_CONCURRENCY, url });
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

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

      const isCatalogue = index % 3 === 0 ? 0 : 1;

      statements.push(
        {
          args: [trackId, `Track ${index}`, `["Artist ${index % artistCount}"]`, isCatalogue],
          sql: `insert into tracks
            (track_id, title, artists_json, spotify_uri, spotify_url, duration_ms, has_embedding,
             is_catalogue)
            values (?, ?, ?, 'spotify:track:x', 'https://open.spotify.com/track/x', 270000, 1, ?)`,
        },
        {
          args: [trackId, vector],
          sql: `insert into track_embeddings (track_id, embedding_blob) values (?, vector32(?))`,
        },
        {
          args: [trackId, artistId],
          sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 1)`,
        },
      );

      if (index % 3 === 0) {
        statements.push({
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

const EDGE_RERANK_SQL = `select ac.artist_id as neighbour_id,
             vector_distance_cos(
               ac.centroid_blob,
               (select centroid_blob from artist_centroids where artist_id = ?)
             ) as dist
      from artist_centroids ac
      where ac.artist_id <> ?
      order by dist asc, ac.artist_id asc
      limit ?`;

async function recomputeCentroids(artistIds: string[]): Promise<void> {
  const now = new Date().toISOString();

  for (let start = 0; start < artistIds.length; start += ARTIST_RANK_CHUNK) {
    const chunkIds = artistIds.slice(start, start + ARTIST_RANK_CHUNK);
    const placeholders = chunkIds.map(() => "?").join(", ");
    const vectorResult = await client.execute({
      args: chunkIds,
      sql: `select ta.artist_id as artist_id, emb.embedding_blob as embedding_blob
            from track_artists ta
            join track_embeddings emb on emb.track_id = ta.track_id
            where ta.artist_id in (${placeholders})`,
    });

    const grouped = new Map<string, { count: number; vectors: number[][] }>();

    for (const id of chunkIds) {
      grouped.set(id, { count: 0, vectors: [] });
    }

    for (const row of vectorResult.rows) {
      const entry = grouped.get(cell(row.artist_id));

      if (!entry) {
        continue;
      }

      entry.count += 1;
      const vector = readEmbeddingBlob(row.embedding_blob);

      if (vector) {
        entry.vectors.push(vector);
      }
    }

    const writes = [];

    for (const id of chunkIds) {
      const entry = grouped.get(id);
      const mean = entry ? meanEmbedding(entry.vectors) : null;

      if (entry && entry.count > 0 && mean) {
        writes.push({
          args: [id, JSON.stringify(mean), entry.count, `v1:${entry.count}`, now],
          sql: `insert into artist_centroids (artist_id, centroid_blob, vector_count, rank_corpus, computed_at)
                values (?, vector32(?), ?, ?, ?)
                on conflict(artist_id) do update set centroid_blob = excluded.centroid_blob,
                  vector_count = excluded.vector_count, rank_corpus = excluded.rank_corpus,
                  computed_at = excluded.computed_at`,
        });
      }
    }

    if (writes.length > 0) {
      await client.batch(writes, "write");
    }
  }
}

async function seedCentroidsAndEdges(): Promise<void> {
  const now = new Date().toISOString();
  const allIds = Array.from({ length: artistCount }, (_, index) => `ar-${index}`);

  await recomputeCentroids(allIds);
  process.stdout.write(`  centroids ${artistCount}/${artistCount}\n`);

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
                values (?, ?, ?, ?, 'v1:1', ?)`,
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

  console.log("Seeding the maintained hub counters…");
  await backfillHubCounts(client, { force: true });
  console.log("Computing centroids + edges (the initial full drain)…");
  await seedCentroidsAndEdges();

  const probe = "ar-1";

  const recomputeIds = Array.from(
    { length: Math.min(RECOMPUTE_N, artistCount) },
    (_, index) => `ar-${(index * 7) % artistCount}`,
  );

  console.log("\n── p50 per shape ────────────────────────────────────────────────");

  const recomputeSamples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    recomputeSamples.push(await timeIt(() => recomputeCentroids(recomputeIds)));
  }
  const recomputeP50 = percentile(recomputeSamples, 50);
  const recomputeOk = recomputeP50 < RECOMPUTE_BUDGET_MS;
  console.log(
    `  (a) centroid recompute (${recomputeIds.length} batched) p50 ${recomputeP50.toFixed(1).padStart(8)} ms  ${
      recomputeOk ? "✓ under" : "✗ OVER"
    } ${RECOMPUTE_BUDGET_MS} ms`,
  );

  const rerankSamples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    rerankSamples.push(
      await timeIt(() =>
        client.execute({ args: [probe, probe, ARTIST_SIMILAR_EDGES], sql: EDGE_RERANK_SQL }),
      ),
    );
  }
  const rerankP50 = percentile(rerankSamples, 50);
  console.log(
    `  (b) edge re-rank scan (1 probe)     p50 ${rerankP50.toFixed(1).padStart(8)} ms  (recorded — the ${artistCount}-centroid scan wall)`,
  );

  const readSamples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    readSamples.push(
      await timeIt(() => client.execute({ args: [probe, 4], sql: ARTIST_NEIGHBOURS_SQL })),
    );
  }
  const readP50 = percentile(readSamples, 50);
  const readOk = readP50 < READ_BUDGET_MS;
  console.log(
    `  (c) getArtistNeighbours read        p50 ${readP50.toFixed(1).padStart(8)} ms  ${
      readOk ? "✓ under" : "✗ OVER"
    } ${READ_BUDGET_MS} ms`,
  );

  const perArtistPass1 = recomputeP50 / recomputeIds.length;
  const projectedPass1 = perArtistPass1 * ARTIST_RANK_BATCH_SIZE;
  const projectedPass2 = rerankP50 * ARTIST_RANK_BATCH_SIZE;
  const projectedTick = projectedPass1 + projectedPass2;
  const tickFits = projectedTick < TICK_TIMER_MS;
  const drainTicks = Math.ceil(artistCount / ARTIST_RANK_BATCH_SIZE);

  console.log("\n── projected at the default limit ───────────────────────────────");
  console.log(
    `  default limit ${ARTIST_RANK_BATCH_SIZE}: one full tick ≈ ${(projectedTick / 1000).toFixed(1)} s ` +
      `(pass1 ≈ ${(projectedPass1 / 1000).toFixed(1)} s + pass2 ≈ ${(projectedPass2 / 1000).toFixed(1)} s)  ${
        tickFits ? "✓ fits" : "✗ EXCEEDS"
      } the ${TICK_TIMER_MS / 1000} s timer`,
  );
  console.log(
    `  cold whole-archive drain: ${drainTicks} ticks (~${((projectedTick * drainTicks) / 60_000).toFixed(0)} min of DB time, operator loops the CLI)`,
  );

  console.log("\n── EXPLAIN QUERY PLAN ───────────────────────────────────────────");
  const rerankPlan = await explain(EDGE_RERANK_SQL, [probe, probe, ARTIST_SIMILAR_EDGES]);
  console.log(`  (b) edge re-rank:\n      ${rerankPlan}\n`);
  const readPlan = await explain(ARTIST_NEIGHBOURS_SQL, [probe, 4]);
  console.log(`  (c) neighbours read:\n      ${readPlan}`);

  const readRidesPk = /USING (PRIMARY KEY|INDEX)/.test(readPlan);
  const readFullScan = /SCAN artist_similar\b(?! USING)/.test(readPlan);
  console.log(
    `  → ${readRidesPk ? "rides an index" : "NOT on an index"}${
      readFullScan ? " — WARNING: a full SCAN artist_similar appears" : ""
    }\n`,
  );

  const pass = recomputeOk && readOk && tickFits;
  console.log(
    pass
      ? "SHIP GATE: PASS — (a) ≤ 4 s/100, (c) < 100 ms, and one full tick fits the 600 s timer."
      : "SHIP GATE: FAIL — (a)/(c) over budget, or a full tick exceeds the 600 s timer. Do NOT merge.",
  );
  process.exit(pass ? 0 : 1);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
