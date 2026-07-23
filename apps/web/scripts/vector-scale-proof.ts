// HOSTED-SCALE PROOF HARNESS for the coarse-scan + exact-rescore vector primitive
// (RFC vector-search-scale, slice A — lib/server/vector-search.ts).
//
// AGENTS.md + docs/local-database.md are emphatic: a vector scan's scale behaviour MUST be proven
// against HOSTED Turso, never `turso dev` — the float32 blob-drag cliff, the isolate cap, and the
// planner traps all reproduce ONLY on hosted. So this script does NOT touch the app database and is
// NOT run in CI or by an agent. The OPERATOR points it at a THROWAWAY hosted scratch DB, it seeds a
// scratch table to N rows carrying BOTH the float32 `embedding_blob` and the int8 `embedding_f8`
// code, then measures, for the two live shapes (sonic = 1 probe, recommendations = P probes folded
// by `min`):
//
//   • p50 / p95 latency of the OLD path (a single EXACT float32 scan) vs the NEW path (coarse int8
//     scan → exact float32 rescore of the top-N), and
//   • top-K RECALL of the NEW path vs the exact float32 baseline (the OLD path's own result).
//
// It creates NOTHING in the app schema and drops its scratch table at the end. It does not create
// the hosted DB — the operator does (see vector-scale-proof.README.md for the exact commands).
//
//   bun run scripts/vector-scale-proof.ts --rows 150000 --trials 40 --k 12 --probes 12
//
// Env (a SCRATCH hosted DB, destroyed after — NEVER the prod URL):
//   TURSO_DATABASE_URL   libsql://<scratch-db>.turso.io
//   TURSO_AUTH_TOKEN     the scratch DB's token

import { type Client, createClient } from "@libsql/client";

const DIMS = 1024;
const TABLE = "vector_scale_proof";
const BATCH = 500;
const CANDIDATE_OVERFETCH = 8; // must track COARSE_OVERFETCH in lib/server/vector-search.ts

type Args = { k: number; probes: number; rows: number; trials: number };

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: number): number => {
    const index = argv.indexOf(flag);
    const value = index >= 0 ? Number.parseInt(argv[index + 1] ?? "", 10) : Number.NaN;

    return Number.isFinite(value) ? value : fallback;
  };

  return {
    k: get("--k", 12),
    probes: get("--probes", 12),
    rows: get("--rows", 150_000),
    trials: get("--trials", 40),
  };
}

/** A deterministic PRNG so a re-run seeds the SAME corpus (comparable numbers across runs). */
function mulberry32(seed: number): () => number {
  let state = seed;

  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomVector(random: () => number): number[] {
  return Array.from({ length: DIMS }, () => random() * 2 - 1);
}

/** Bind a probe as a RAW float32 blob — the rule-2 form (never a re-parsed text vector). */
function toVectorProbe(vector: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}

/** Encode a probe to a RAW int8 (`vector8`) blob via one round trip — the coarse probe. */
async function encodeF8Probe(db: Client, vector: number[]): Promise<Uint8Array> {
  const result = await db.execute({
    args: [JSON.stringify(vector)],
    sql: `select vector8(?) as p`,
  });
  const cell = result.rows[0]?.p;

  if (cell instanceof ArrayBuffer) {
    return new Uint8Array(cell);
  }

  if (ArrayBuffer.isView(cell)) {
    return new Uint8Array(cell.buffer.slice(cell.byteOffset, cell.byteOffset + cell.byteLength));
  }

  throw new Error("vector8 probe encode returned no blob");
}

async function seed(db: Client, rows: number, random: () => number): Promise<number[][]> {
  console.log(`Seeding ${rows.toLocaleString()} rows (float32 + int8) into ${TABLE} …`);
  await db.execute(`drop table if exists ${TABLE}`);
  await db.execute(
    `create table ${TABLE} (id integer primary key, bpm integer, embedding_blob F32_BLOB(${DIMS}), embedding_f8 F8_BLOB(${DIMS}))`,
  );

  // Keep a sample of seeded vectors to use as realistic probes (a query "sounds like" a real row).
  const samples: number[][] = [];
  const sampleEvery = Math.max(1, Math.floor(rows / 200));

  for (let start = 0; start < rows; start += BATCH) {
    const statements = [];

    for (let i = start; i < Math.min(start + BATCH, rows); i += 1) {
      const vector = randomVector(random);
      const json = JSON.stringify(vector);

      if (i % sampleEvery === 0) {
        samples.push(vector);
      }

      statements.push({
        args: [i, 170 + (i % 20), json, json],
        sql: `insert into ${TABLE} (id, bpm, embedding_blob, embedding_f8) values (?, ?, vector32(?), vector8(?))`,
      });
    }

    await db.batch(statements, "write");

    if (start % (BATCH * 40) === 0) {
      console.log(`  … ${start.toLocaleString()} / ${rows.toLocaleString()}`);
    }
  }

  console.log(`Seeded. ${samples.length} sample probe vectors retained.`);

  return samples;
}

function foldSql(column: string, count: number): string {
  const terms = Array.from({ length: count }, () => `vector_distance_cos(${column}, ?)`);

  return count === 1 ? (terms[0] ?? "") : `min(${terms.join(", ")})`;
}

/** OLD path: one EXACT float32 scan, `min`-folded over the probes — returns the top-K ids. */
async function oldPath(db: Client, exactProbes: Uint8Array[], k: number): Promise<number[]> {
  const result = await db.execute({
    args: [...exactProbes, k],
    sql: `select id from ${TABLE}
          where embedding_blob is not null
          order by ${foldSql("embedding_blob", exactProbes.length)} asc, id asc
          limit ?`,
  });

  return result.rows.map((row) => Number(row.id));
}

/** NEW path: coarse int8 scan (top-N) → exact float32 rescore of those ids → top-K ids. */
async function newPath(
  db: Client,
  coarseProbes: Uint8Array[],
  exactProbes: Uint8Array[],
  k: number,
): Promise<number[]> {
  const n = k * CANDIDATE_OVERFETCH;
  const coarse = await db.execute({
    args: [...coarseProbes, n],
    sql: `select id from ${TABLE}
          where embedding_blob is not null
          order by ${foldSql("embedding_f8", coarseProbes.length)} asc, id asc
          limit ?`,
  });
  const ids = coarse.rows.map((row) => Number(row.id));

  if (ids.length === 0) {
    return [];
  }

  const rescore = await db.execute({
    args: [...exactProbes, ...ids, k],
    sql: `select id from ${TABLE}
          where id in (${ids.map(() => "?").join(", ")}) and embedding_blob is not null
          order by ${foldSql("embedding_blob", exactProbes.length)} asc, id asc
          limit ?`,
  });

  return rescore.rows.map((row) => Number(row.id));
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));

  return sorted[index] ?? 0;
}

async function measureShape(
  db: Client,
  label: string,
  samples: number[][],
  probeCount: number,
  args: Args,
  random: () => number,
): Promise<void> {
  const oldMs: number[] = [];
  const newMs: number[] = [];
  let recallHits = 0;

  for (let t = 0; t < args.trials; t += 1) {
    const chosen = Array.from(
      { length: probeCount },
      () => samples[Math.floor(random() * samples.length)] ?? samples[0] ?? [],
    );
    const exactProbes = chosen.map(toVectorProbe);
    const coarseProbes = await Promise.all(chosen.map((vector) => encodeF8Probe(db, vector)));

    const t0 = performance.now();
    const oldTop = await oldPath(db, exactProbes, args.k);
    oldMs.push(performance.now() - t0);

    const t1 = performance.now();
    const newTop = await newPath(db, coarseProbes, exactProbes, args.k);
    newMs.push(performance.now() - t1);

    const oldSet = new Set(oldTop);
    recallHits += newTop.filter((id) => oldSet.has(id)).length;
  }

  const recall = (recallHits / (args.trials * args.k)) * 100;

  console.log(`\n── ${label} (${probeCount} probe${probeCount === 1 ? "" : "s"}) ──`);
  console.log(
    `  OLD (exact f32):   p50 ${percentile(oldMs, 50).toFixed(0)}ms   p95 ${percentile(oldMs, 95).toFixed(0)}ms`,
  );
  console.log(
    `  NEW (coarse+resc): p50 ${percentile(newMs, 50).toFixed(0)}ms   p95 ${percentile(newMs, 95).toFixed(0)}ms`,
  );
  console.log(`  top-${args.k} recall (NEW vs exact baseline): ${recall.toFixed(2)}%`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url || !authToken) {
    console.error("Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN to a THROWAWAY hosted scratch DB.");
    process.exit(1);
  }

  if (url.includes("localhost") || url.startsWith("file:") || url.startsWith("http://127")) {
    console.error("Refusing to run against a LOCAL url — the whole point is hosted Turso.");
    process.exit(1);
  }

  const db = createClient({ authToken, url });
  const random = mulberry32(1);
  const samples = await seed(db, args.rows, random);

  console.log(`\nMeasuring ${args.trials} trials, k=${args.k} …`);
  await measureShape(db, "SONIC search", samples, 1, args, random);
  await measureShape(db, "RECOMMENDATIONS", samples, args.probes, args, random);

  console.log(`\nDropping scratch table ${TABLE} …`);
  await db.execute(`drop table if exists ${TABLE}`);
  console.log("Done. Destroy the scratch DB now.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
