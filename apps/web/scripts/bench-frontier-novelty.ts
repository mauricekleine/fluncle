#!/usr/bin/env bun

import { createClient } from "@libsql/client/web";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { DUPLICATE_SIMILARITY, LONG_FORM_MS } from "../src/lib/server/catalogue";
import { toVectorProbe } from "../src/lib/server/embedding";
import {
  FINDINGS_SLOT_COUNT,
  FRONTIER_NOVELTY_WINDOW,
  MAX_REC_SEEDS,
  RECOMMENDATIONS_POOL,
} from "../src/lib/server/recommendations";

const DIMS = 1024;

const BUDGET_MS = 800;

function fail(message: string): never {
  console.error(`bench-frontier-novelty: ${message}`);
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

const candidateCounts = (process.env.BENCH_CANDIDATE_COUNTS ?? "5000,10000,25000")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10));
const findingsCount = envInt("BENCH_FINDINGS", 5000);
const userCount = envInt("BENCH_USERS", 10_000);
const editionsPerUser = envInt("BENCH_EDITIONS_PER_USER", FRONTIER_NOVELTY_WINDOW);
const tracksPerEdition = envInt("BENCH_TRACKS_PER_EDITION", 33);
const iterations = envInt("BENCH_ITERATIONS", 10);

const client = createClient({ authToken, concurrency: REMOTE_DB_CONCURRENCY, url });
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

function randomUnitVector(): number[] {
  const vector = Array.from({ length: DIMS }, () => Math.random() - 0.5);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;

  return vector.map((value) => value / norm);
}

function blobArg(vector: number[]): Uint8Array {
  return toVectorProbe(vector);
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

async function seedCandidates(from: number, count: number): Promise<void> {
  const chunk = 400;

  for (let start = from; start < count; start += chunk) {
    const end = Math.min(count, start + chunk);
    const statements = [];

    for (let index = start; index < end; index += 1) {
      const trackId = `cand-${index}`;

      statements.push(
        {
          args: [
            trackId,
            `Candidate ${index}`,
            `["Artist ${index % 500}"]`,
            `spotify:track:${trackId}`,
            `https://open.spotify.com/track/${trackId}`,
            270_000,
          ],
          sql: `insert or ignore into tracks
          (track_id, title, artists_json, spotify_uri, spotify_url, duration_ms, has_embedding)
          values (?, ?, ?, ?, ?, ?, 1)`,
        },
        {
          args: [trackId, blobArg(randomUnitVector())],
          sql: `insert or ignore into track_embeddings (track_id, embedding_blob) values (?, ?)`,
        },
      );
    }

    await client.batch(statements, "write");
    process.stdout.write(`\r  candidates ${end}/${count}`);
  }

  process.stdout.write("\n");
}

async function seedFindings(count: number): Promise<void> {
  const chunk = 400;

  for (let start = 0; start < count; start += chunk) {
    const end = Math.min(count, start + chunk);
    const statements = [];

    for (let index = start; index < end; index += 1) {
      const trackId = `find-${index}`;

      statements.push(
        {
          args: [
            trackId,
            `Finding ${index}`,
            `["Finding Artist ${index % 500}"]`,
            `spotify:track:${trackId}`,
            `https://open.spotify.com/track/${trackId}`,
            270_000,
          ],
          sql: `insert or ignore into tracks
            (track_id, title, artists_json, spotify_uri, spotify_url, duration_ms, has_embedding)
            values (?, ?, ?, ?, ?, ?, 1)`,
        },
        {
          args: [trackId, blobArg(randomUnitVector())],
          sql: `insert or ignore into track_embeddings (track_id, embedding_blob) values (?, ?)`,
        },
        {
          args: [trackId, `${String(index).padStart(3, "0")}.1.1A`, new Date().toISOString()],
          sql: `insert or ignore into findings (track_id, log_id, added_at) values (?, ?, ?)`,
        },
      );
    }

    await client.batch(statements, "write");
    process.stdout.write(`\r  findings ${end}/${count}`);
  }

  process.stdout.write("\n");
}

async function seedEditions(): Promise<string> {
  let targetUserId = "";

  for (let user = 0; user < userCount; user += 1) {
    const userId = `bench-user-${user}`;

    if (user === 0) {
      targetUserId = userId;
    }

    const statements = [];

    for (let edition = 1; edition <= editionsPerUser; edition += 1) {
      const editionId = randomUUID();

      statements.push({
        args: [editionId, userId, edition, new Date().toISOString()],
        sql: `insert or ignore into frontier_editions (id, user_id, number, created_at) values (?, ?, ?, ?)`,
      });

      for (let position = 1; position <= tracksPerEdition; position += 1) {
        const trackId =
          user === 0
            ? `cand-${(edition - 1) * tracksPerEdition + position}`
            : `frozen-${user}-${edition}-${position}`;

        statements.push({
          args: [editionId, position, trackId, "Frozen", `["Frozen"]`, "catalogue"],
          sql: `insert or ignore into frontier_edition_tracks
            (edition_id, position, track_id, title_text, artists_text, slot)
            values (?, ?, ?, ?, ?, ?)`,
        });
      }
    }

    await client.batch(statements, "write");

    if (user % 500 === 0) {
      process.stdout.write(`\r  editions users ${user}/${userCount}`);
    }
  }

  process.stdout.write("\n");

  return targetUserId;
}

const DERIVE_SQL = `select fet.track_id
  from frontier_editions fe
  join frontier_edition_tracks fet on fet.edition_id = fe.id
  where fe.user_id = ?
    and fe.id in (select id from frontier_editions where user_id = ? order by number desc limit ?)
  group by fet.track_id`;

function catalogueScan(probes: Uint8Array[], excludedIds: string[]) {
  const distanceTerms = probes.map(() => "vector_distance_cos(emb.embedding_blob, ?)");
  const bestDistance =
    distanceTerms.length === 1 ? distanceTerms.join("") : `min(${distanceTerms.join(", ")})`;
  const recentExclusion =
    excludedIds.length > 0
      ? `and t.track_id not in (${excludedIds.map(() => "?").join(", ")})`
      : "";

  return {
    args: [...probes, ...excludedIds, RECOMMENDATIONS_POOL],
    sql: `select track_id, dist from (
        select t.track_id, ${bestDistance} as dist
        from tracks t
        left join findings f on f.track_id = t.track_id
        left join track_embeddings emb on emb.track_id = t.track_id
        where f.track_id is null
          and emb.track_id is not null
          and t.spotify_uri is not null
          and t.dismissed_at is null
          and t.duplicate_of_track_id is null
          and (t.nearest_finding_score is null or t.nearest_finding_score < ${DUPLICATE_SIMILARITY})
          and t.duration_ms < ${LONG_FORM_MS}
          ${recentExclusion}
      )
      where dist is not null
      order by dist asc, track_id asc
      limit ?`,
  };
}

function findingsScan(probes: Uint8Array[], excludedIds: string[]) {
  const distanceTerms = probes.map(() => "vector_distance_cos(emb.embedding_blob, ?)");
  const bestDistance =
    distanceTerms.length === 1 ? distanceTerms.join("") : `min(${distanceTerms.join(", ")})`;
  const recentExclusion =
    excludedIds.length > 0
      ? `and t.track_id not in (${excludedIds.map(() => "?").join(", ")})`
      : "";

  return {
    args: [...probes, ...excludedIds, FINDINGS_SLOT_COUNT],
    sql: `select track_id, dist from (
        select t.track_id, ${bestDistance} as dist
        from findings f
        cross join tracks t on t.track_id = f.track_id
        cross join track_embeddings emb on emb.track_id = t.track_id
        where f.log_id is not null
          ${recentExclusion}
      )
      where dist is not null
      order by dist asc, track_id asc
      limit ?`,
  };
}

function cell(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
}

async function explain(sql: string, args: Array<Uint8Array | number | string>): Promise<string> {
  const result = await client.execute({ args, sql: `explain query plan ${sql}` });

  return result.rows.map((row) => cell(row.detail)).join("\n      ");
}

async function main(): Promise<void> {
  console.log("bench-frontier-novelty — applying migrations to the scratch DB…");
  await migrate(drizzle(client), { migrationsFolder });

  console.log(`Seeding ${findingsCount} findings…`);
  await seedFindings(findingsCount);

  console.log(
    `Seeding editions: ${userCount} users × ${editionsPerUser} editions × ${tracksPerEdition} tracks…`,
  );
  const targetUserId = await seedEditions();

  const probes = Array.from({ length: MAX_REC_SEEDS }, () => toVectorProbe(randomUnitVector()));

  const derived = await client.execute({
    args: [targetUserId, targetUserId, FRONTIER_NOVELTY_WINDOW],
    sql: DERIVE_SQL,
  });
  const excludedIds = derived.rows.map((row) => cell(row.track_id));
  console.log(`Derived recent-set size: ${excludedIds.length} ids\n`);

  let allWithinBudget = true;

  for (const count of candidateCounts) {
    const existing = Number(
      (
        await client.execute(`select count(*) as n from tracks t
        left join findings f on f.track_id = t.track_id where f.track_id is null`)
      ).rows[0]?.n ?? 0,
    );

    if (existing < count) {
      await seedCandidates(existing, count);
    }

    const deriveSamples: number[] = [];
    const catalogueSamples: number[] = [];
    const findingsSamples: number[] = [];
    const refreshSamples: number[] = [];

    const baseCatalogueSamples: number[] = [];
    const baseFindingsSamples: number[] = [];

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const derive = () =>
        client.execute({
          args: [targetUserId, targetUserId, FRONTIER_NOVELTY_WINDOW],
          sql: DERIVE_SQL,
        });
      const catalogue = () => client.execute(catalogueScan(probes, excludedIds));
      const findings = () => client.execute(findingsScan(probes, excludedIds));

      deriveSamples.push(await timeIt(derive));
      catalogueSamples.push(await timeIt(catalogue));
      findingsSamples.push(await timeIt(findings));
      baseCatalogueSamples.push(await timeIt(() => client.execute(catalogueScan(probes, []))));
      baseFindingsSamples.push(await timeIt(() => client.execute(findingsScan(probes, []))));
      refreshSamples.push(
        await timeIt(async () => {
          await derive();
          await catalogue();
          await findings();
        }),
      );
    }

    const refreshP50 = percentile(refreshSamples, 50);
    const withinBudget = refreshP50 < BUDGET_MS;
    allWithinBudget &&= withinBudget;

    const baseCatP50 = percentile(baseCatalogueSamples, 50);
    const baseFindP50 = percentile(baseFindingsSamples, 50);
    const catP50 = percentile(catalogueSamples, 50);
    const findP50 = percentile(findingsSamples, 50);

    console.log(`── ${count} candidates ─────────────────────────────────────────`);
    console.log(`  derive        p50 ${percentile(deriveSamples, 50).toFixed(1)} ms`);
    console.log(
      `  catalogue     p50 ${catP50.toFixed(1)} ms  (base ${baseCatP50.toFixed(1)} ms → novelty +${(catP50 - baseCatP50).toFixed(1)} ms)`,
    );
    console.log(
      `  findings      p50 ${findP50.toFixed(1)} ms  (base ${baseFindP50.toFixed(1)} ms → novelty +${(findP50 - baseFindP50).toFixed(1)} ms)`,
    );
    console.log(
      `  FULL REFRESH  p50 ${refreshP50.toFixed(1)} ms  ${withinBudget ? "✓ under" : "✗ OVER"} ${BUDGET_MS} ms budget`,
    );
    console.log("");
  }

  console.log("── EXPLAIN QUERY PLAN ───────────────────────────────────────────");
  const derivePlan = await explain(DERIVE_SQL, [
    targetUserId,
    targetUserId,
    FRONTIER_NOVELTY_WINDOW,
  ]);
  console.log(`  derive:\n      ${derivePlan}`);
  const derivesUserIndex =
    /USING (COVERING )?INDEX/.test(derivePlan) &&
    !/SCAN frontier_editions\b(?! USING)/.test(derivePlan);
  console.log(
    `  → ${derivesUserIndex ? "✓ user_id-INDEX path" : "✗ NOT an index path — investigate before activating"}\n`,
  );

  const catalogueStatement = catalogueScan(probes, excludedIds);
  const cataloguePlan = await explain(catalogueStatement.sql, catalogueStatement.args);
  console.log(`  catalogue scan:\n      ${cataloguePlan}`);

  const trackScans = (cataloguePlan.match(/\btracks\b/g) ?? []).length;
  console.log(
    `  → tracks referenced ${trackScans}× in the plan (expect 1 — a single pass, no correlated re-scan)\n`,
  );

  console.log(
    allWithinBudget
      ? "SHIP GATE: PASS — full-refresh p50 under budget across the sweep."
      : "SHIP GATE: FAIL — a candidate count blew the 800 ms budget. Do NOT activate novelty.",
  );
  process.exit(allWithinBudget ? 0 : 1);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
