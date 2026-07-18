#!/usr/bin/env bun
/**
 * THROWAWAY HOSTED-SCALE BENCH — the ship gate for Frontier novelty (Unit A1,
 * docs/rfcs/frontier-editions-rfc.md §A1.3). NOT a test, NOT wired into CI.
 *
 * ── WHO RUNS THIS, AND WHEN ───────────────────────────────────────────────────
 * THE OPERATOR runs it ONCE, by hand, against a SCRATCH hosted Turso Cloud DB, as the
 * PRE-ACTIVATION GATE before novelty is turned on (before A2's refresh path passes
 * `excludeRecent: true` for real). It CANNOT run in this repo's CI or an agent's Bash
 * session: it needs Turso Cloud credentials for a throwaway database, which are
 * operator-only. `turso dev` is NOT evidence here — docs/local-database.md "Local is not
 * production": the exact behaviours that decide whether a growing-table scan survives
 * (the blob-vs-text probe cliff, the index-vs-scan plan, a correlated re-scan) diverge
 * between sqld and hosted, and the local one is misleading in the DANGEROUS direction.
 * An agent may (and this build did) self-check the SQL shapes against local `turso dev`
 * for CORRECTNESS only — never for a performance number.
 *
 * ── WHAT IT MEASURES (the RFC's ship gate) ────────────────────────────────────
 *   1. A CANDIDATE-count sweep — 5k / 10k / 25k EMBEDDED, Spotify-anchored catalogue
 *      candidates (the WHERE decides candidates, NOT the raw `tracks` count), the
 *      big-catalogue regime A1 designs for.
 *   2. An ABSOLUTE p50 budget: the full refresh (derive + catalogue-scan-with-exclusion
 *      + findings-scan-with-exclusion) must come in UNDER 800 ms hosted. A ratio is
 *      worthless if the baseline is already over budget past the ~5–10k tripwire.
 *   3. A MULTI-USER seed (default 10k users × 8 editions) so `EXPLAIN QUERY PLAN` on the
 *      recent-set derive shows a `user_id`-INDEX path, never `SCAN frontier_editions` —
 *      a one-user seed would hide a cross-user scan.
 *   4. The 264-id `NOT IN` did NOT become a correlated re-scan: `EXPLAIN` still shows one
 *      pass over `tracks`.
 *
 * ── THE PROBE-BINDING DISCIPLINE (do not "fix" this) ──────────────────────────
 * Every query vector is bound as a raw float32 BLOB (`toVectorProbe`), never text — the
 * 14× hosted cliff (docs/local-database.md trap #1). The scan is the ratified one-pass
 * folded-`min` shape from recommendations.ts, verbatim, with the novelty `NOT IN` added.
 *
 * ── FOLLOW-ON THE CACHE WORK MUST HONOR (recorded here per RFC §A1.3) ──────────
 * The engine's planned per-user cache is keyed by (seed set, corpus fingerprint). The
 * novelty set rotates per-refresh and is per-user — NOT in that key. The refresh path's
 * cache key MUST fold in the edition-window hash, or novelty serves stale results / busts
 * the cache every refresh. A1 is scoped to the PRE-cache regime; this is the named
 * follow-on, not something this bench fixes.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────────
 *   SCRATCH_TURSO_DATABASE_URL=libsql://<scratch>.turso.io \
 *   SCRATCH_TURSO_AUTH_TOKEN=<token> \
 *   bun run apps/web/scripts/bench-frontier-novelty.ts
 *
 * Optional env (seed volumes — dial down for a faster smoke, up for the real gate):
 *   BENCH_CANDIDATE_COUNTS=5000,10000,25000   BENCH_FINDINGS=5000
 *   BENCH_USERS=10000   BENCH_EDITIONS_PER_USER=8   BENCH_TRACKS_PER_EDITION=33
 *   BENCH_ITERATIONS=10
 *
 * The operator CREATES the scratch DB before, and DESTROYS it after — this script only
 * measures. It NEVER points at `fluncle` or `fluncle-dev` (it refuses a URL containing
 * either name as a guard).
 */
import { createClient } from "@libsql/client/web";
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
/** The absolute ship-gate budget — the full refresh's p50 must be under this, hosted. */
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

const client = createClient({ authToken, url });
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/** A random unit vector — a synthetic embedding (values, not realism, are what a scan costs). */
function randomUnitVector(): number[] {
  const vector = Array.from({ length: DIMS }, () => Math.random() - 0.5);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;

  return vector.map((value) => value / norm);
}

/** The raw-BLOB embedding write (NOT `vector32(text)`) — the fast, hosted-honest form. */
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

/** Insert `count` embedded catalogue candidates (a `tracks` row, no `findings` row). */
async function seedCandidates(count: number): Promise<void> {
  const chunk = 400;

  for (let start = 0; start < count; start += chunk) {
    const end = Math.min(count, start + chunk);
    const statements = [];

    for (let index = start; index < end; index += 1) {
      const trackId = `cand-${index}`;

      statements.push({
        args: [
          trackId,
          `Candidate ${index}`,
          `["Artist ${index % 500}"]`,
          `spotify:track:${trackId}`,
          `https://open.spotify.com/track/${trackId}`,
          270_000,
          blobArg(randomUnitVector()),
        ],
        sql: `insert into tracks
          (track_id, title, artists_json, spotify_uri, spotify_url, duration_ms, embedding_blob)
          values (?, ?, ?, ?, ?, ?, ?)`,
      });
    }

    await client.batch(statements, "write");
    process.stdout.write(`\r  candidates ${end}/${count}`);
  }

  process.stdout.write("\n");
}

/** Insert `count` embedded certified findings (a `tracks` row + its `findings` row). */
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
            blobArg(randomUnitVector()),
          ],
          sql: `insert into tracks
            (track_id, title, artists_json, spotify_uri, spotify_url, duration_ms, embedding_blob)
            values (?, ?, ?, ?, ?, ?, ?)`,
        },
        {
          args: [trackId, `${String(index).padStart(3, "0")}.1.1A`, new Date().toISOString()],
          sql: `insert into findings (track_id, log_id, added_at) values (?, ?, ?)`,
        },
      );
    }

    await client.batch(statements, "write");
    process.stdout.write(`\r  findings ${end}/${count}`);
  }

  process.stdout.write("\n");
}

/**
 * Seed `userCount` users' editions (each with `editionsPerUser` × `tracksPerEdition`
 * frozen rows) so `frontier_editions` is BIG — the only way the derive's `EXPLAIN` can
 * prove a `user_id`-index path rather than a cross-user table scan. Returns the id of the
 * user whose window we measure (a full `editionsPerUser`-deep window).
 */
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
        sql: `insert into frontier_editions (id, user_id, number, created_at) values (?, ?, ?, ?)`,
      });

      for (let position = 1; position <= tracksPerEdition; position += 1) {
        // The TARGET user's frozen rows point at REAL candidate ids so the exclusion has
        // teeth; other users' rows can be arbitrary (they never enter the measured scan).
        const trackId =
          user === 0
            ? `cand-${(edition - 1) * tracksPerEdition + position}`
            : `frozen-${user}-${edition}-${position}`;

        statements.push({
          args: [editionId, position, trackId, "Frozen", `["Frozen"]`, "catalogue"],
          sql: `insert into frontier_edition_tracks
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

/** The exact recent-set derive from recommendations.ts (the outer user_id predicate is load-bearing). */
const DERIVE_SQL = `select fet.track_id
  from frontier_editions fe
  join frontier_edition_tracks fet on fet.edition_id = fe.id
  where fe.user_id = ?
    and fe.id in (select id from frontier_editions where user_id = ? order by number desc limit ?)
  group by fet.track_id`;

/** Build the catalogue scan-with-exclusion, mirroring recommendations.ts verbatim. */
function catalogueScan(probes: Uint8Array[], excludedIds: string[]) {
  const distanceTerms = probes.map(() => "vector_distance_cos(t.embedding_blob, ?)");
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
        where f.track_id is null
          and t.embedding_blob is not null
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

/** Build the findings scan-with-exclusion, mirroring recommendations.ts verbatim. */
function findingsScan(probes: Uint8Array[], excludedIds: string[]) {
  const distanceTerms = probes.map(() => "vector_distance_cos(t.embedding_blob, ?)");
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
        from findings f cross join tracks t
        where t.track_id = f.track_id
          and f.log_id is not null
          and t.embedding_blob is not null
          ${recentExclusion}
      )
      where dist is not null
      order by dist asc, track_id asc
      limit ?`,
  };
}

/** A libSQL cell → string, without tripping no-base-to-string (a raw `Value` may be an object). */
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

  // The 12-probe worst case (MAX_REC_SEEDS), each bound as a raw BLOB.
  const probes = Array.from({ length: MAX_REC_SEEDS }, () => toVectorProbe(randomUnitVector()));

  // The recent set the engine would derive for the target user — the real exclusion input.
  const derived = await client.execute({
    args: [targetUserId, targetUserId, FRONTIER_NOVELTY_WINDOW],
    sql: DERIVE_SQL,
  });
  const excludedIds = derived.rows.map((row) => cell(row.track_id));
  console.log(`Derived recent-set size: ${excludedIds.length} ids\n`);

  let allWithinBudget = true;

  for (const count of candidateCounts) {
    // Grow the candidate pool up to `count` (idempotent across the ascending sweep).
    const existing = Number(
      (
        await client.execute(`select count(*) as n from tracks t
        left join findings f on f.track_id = t.track_id where f.track_id is null`)
      ).rows[0]?.n ?? 0,
    );

    if (existing < count) {
      await seedCandidates(count);
    }

    const deriveSamples: number[] = [];
    const catalogueSamples: number[] = [];
    const findingsSamples: number[] = [];
    const refreshSamples: number[] = [];

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

    console.log(`── ${count} candidates ─────────────────────────────────────────`);
    console.log(`  derive        p50 ${percentile(deriveSamples, 50).toFixed(1)} ms`);
    console.log(`  catalogue     p50 ${percentile(catalogueSamples, 50).toFixed(1)} ms`);
    console.log(`  findings      p50 ${percentile(findingsSamples, 50).toFixed(1)} ms`);
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
  // One pass over `tracks`: the plan must not show the scan more than once (a correlated re-scan).
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
