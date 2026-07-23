// HOSTED-SCALE PROOF HARNESS for the coarse-scan + exact-rescore vector primitive
// (RFC vector-search-scale, slice A — lib/server/vector-search.ts).
//
// AGENTS.md + docs/local-database.md are emphatic: a vector scan's scale behaviour MUST be proven
// against HOSTED Turso, never `turso dev` — the float32 blob-drag cliff, the isolate cap, and the
// planner traps all reproduce ONLY on hosted. So this script does NOT touch the app database and is
// NOT run in CI or by an agent. The OPERATOR points it at a THROWAWAY hosted scratch DB, it seeds a
// scratch table to N rows carrying the float32 `embedding_blob`, the int8 `embedding_f8` code, AND
// the columns the real surfaces PRE-FILTER on (`key`, `anchored`, `certified`), then measures the
// live shapes with their REAL filters:
//
//   • SONIC broad   — a bare "sounds like X" (filter: anchored only) — the realistic HEAVY case.
//   • SONIC narrow  — "sounds like X" in one key (filter: key + anchored) — the light case, showing
//                     whether a tighter btree pre-filter rescues the scan.
//   • RECOMMENDATIONS — P seed probes folded by `min`, filter anchored + uncertified (~70%, broad).
//
// For each: p50/p95 of the OLD path (one EXACT float32 scan) vs the NEW path (coarse int8 scan →
// exact float32 rescore of the top-N), and top-K RECALL of NEW vs the exact baseline. Either path
// exceeding Turso's per-query cap at scale is CAUGHT and reported ("exceeded cap"), never a crash —
// a slow OLD baseline is the whole point, and a slow NEW coarse scan is itself a finding.
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

// The 24 Camelot keys — the real `key` pre-filter narrows a sonic scan to ~1/24 of the corpus.
const KEYS = Array.from({ length: 12 }, (_, i) => [`${i + 1}A`, `${i + 1}B`]).flat();
const NARROW_KEY = "8A"; // a fixed key for the "SONIC narrow" shape's filter

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
  console.log(
    `Seeding ${rows.toLocaleString()} rows (float32 + int8 + filter cols) into ${TABLE} …`,
  );
  await db.execute(`drop table if exists ${TABLE}`);
  await db.execute(
    `create table ${TABLE} (id integer primary key, key text, anchored integer, certified integer,
       embedding_blob F32_BLOB(${DIMS}), embedding_f8 F8_BLOB(${DIMS}))`,
  );

  // Keep a sample of seeded vectors to use as realistic probes (a query "sounds like" a real row).
  const samples: number[][] = [];
  const sampleEvery = Math.max(1, Math.floor(rows / 200));

  for (let start = 0; start < rows; start += BATCH) {
    const statements = [];

    for (let i = start; i < Math.min(start + BATCH, rows); i += 1) {
      const vector = randomVector(random);
      const json = JSON.stringify(vector);
      // Representative distributions of the real pre-filter columns: 24 keys, ~70% anchored
      // (has a Spotify anchor), ~1% certified (most tracks are uncertified catalogue).
      const key = KEYS[i % KEYS.length];
      const anchored = random() < 0.7 ? 1 : 0;
      const certified = random() < 0.01 ? 1 : 0;

      if (i % sampleEvery === 0) {
        samples.push(vector);
      }

      statements.push({
        args: [i, key, anchored, certified, json, json],
        sql: `insert or ignore into ${TABLE} (id, key, anchored, certified, embedding_blob, embedding_f8)
              values (?, ?, ?, ?, vector32(?), vector8(?))`,
      });
    }

    // Hosted Turso over a sustained seed drops the odd connection (ECONNRESET); a batch is
    // transactional so a drop rolls back — retry it. `insert or ignore` keeps a re-run idempotent.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await db.batch(statements, "write");
        break;
      } catch (error) {
        if (attempt >= 6) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }

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

/**
 * OLD path: one EXACT float32 scan under the surface's real `where`, `min`-folded over the probes.
 * The fold sits in the SELECT list as `dist` (mirroring lib/server/vector-search.ts), so binds are
 * probes → where-args → limit.
 */
async function oldPath(
  db: Client,
  exactProbes: Uint8Array[],
  where: string,
  whereArgs: (number | string)[],
  k: number,
): Promise<number[]> {
  const result = await db.execute({
    args: [...exactProbes, ...whereArgs, k],
    sql: `select id, ${foldSql("embedding_blob", exactProbes.length)} as dist
          from ${TABLE} where ${where}
          order by dist asc, id asc limit ?`,
  });

  return result.rows.map((row) => Number(row.id));
}

/** NEW path: coarse int8 scan under the same `where` (top-N) → exact float32 rescore → top-K ids. */
async function newPath(
  db: Client,
  coarseProbes: Uint8Array[],
  exactProbes: Uint8Array[],
  where: string,
  whereArgs: (number | string)[],
  k: number,
): Promise<number[]> {
  const n = k * CANDIDATE_OVERFETCH;
  const coarse = await db.execute({
    args: [...coarseProbes, ...whereArgs, n],
    sql: `select id, ${foldSql("embedding_f8", coarseProbes.length)} as dist
          from ${TABLE} where ${where}
          order by dist asc, id asc limit ?`,
  });
  const ids = coarse.rows.map((row) => Number(row.id));

  if (ids.length === 0) {
    return [];
  }

  const rescore = await db.execute({
    args: [...exactProbes, ...ids, k],
    sql: `select id, ${foldSql("embedding_blob", exactProbes.length)} as dist
          from ${TABLE}
          where id in (${ids.map(() => "?").join(", ")}) and embedding_blob is not null
          order by dist asc, id asc limit ?`,
  });

  return rescore.rows.map((row) => Number(row.id));
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));

  return sorted[index] ?? 0;
}

/** A path's timing over the trials, or how many trials it blew Turso's query cap. */
function report(label: string, ms: number[], failed: number, trials: number): string {
  if (ms.length === 0) {
    return `${label}: exceeded query cap on all ${trials} trials`;
  }
  const tail = failed > 0 ? `  (exceeded cap on ${failed}/${trials})` : "";

  return `${label}: p50 ${percentile(ms, 50).toFixed(0)}ms   p95 ${percentile(ms, 95).toFixed(0)}ms${tail}`;
}

async function measureShape(
  db: Client,
  label: string,
  where: string,
  whereArgs: (number | string)[],
  samples: number[][],
  probeCount: number,
  args: Args,
  random: () => number,
): Promise<void> {
  const oldMs: number[] = [];
  const newMs: number[] = [];
  let oldFailed = 0;
  let newFailed = 0;
  let recallHits = 0;
  let recallTrials = 0;

  for (let t = 0; t < args.trials; t += 1) {
    const chosen = Array.from(
      { length: probeCount },
      () => samples[Math.floor(random() * samples.length)] ?? samples[0] ?? [],
    );
    const exactProbes = chosen.map(toVectorProbe);
    const coarseProbes = await Promise.all(chosen.map((vector) => encodeF8Probe(db, vector)));

    // OLD baseline — may exceed the query cap at scale; that IS the point, so catch it.
    let oldTop: number[] | null = null;
    const t0 = performance.now();
    try {
      oldTop = await oldPath(db, exactProbes, where, whereArgs, args.k);
      oldMs.push(performance.now() - t0);
    } catch {
      oldFailed += 1;
    }

    // NEW coarse+rescore — a slow coarse scan here is itself a finding, so catch it too.
    let newTop: number[] | null = null;
    const t1 = performance.now();
    try {
      newTop = await newPath(db, coarseProbes, exactProbes, where, whereArgs, args.k);
      newMs.push(performance.now() - t1);
    } catch {
      newFailed += 1;
    }

    // Recall only where BOTH completed (the exact baseline is the ground truth).
    if (oldTop && newTop) {
      const oldSet = new Set(oldTop);
      recallHits += newTop.filter((id) => oldSet.has(id)).length;
      recallTrials += 1;
    }
  }

  console.log(
    `\n── ${label} (${probeCount} probe${probeCount === 1 ? "" : "s"}, filter: ${where}) ──`,
  );
  console.log(`  ${report("OLD (exact f32)  ", oldMs, oldFailed, args.trials)}`);
  console.log(`  ${report("NEW (coarse+resc)", newMs, newFailed, args.trials)}`);
  console.log(
    recallTrials > 0
      ? `  top-${args.k} recall (NEW vs exact baseline): ${((recallHits / (recallTrials * args.k)) * 100).toFixed(2)}%  (over ${recallTrials} trials where the baseline completed)`
      : `  top-${args.k} recall: n/a — the exact baseline exceeded the query cap on every trial (recall is quantization-bound; see the narrow shape / unit tests)`,
  );
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
  // The REAL surface filters. Sonic broad (bare "sounds like", ~70% anchored) is the heavy case;
  // sonic narrow (one key, ~3%) shows whether a tighter pre-filter rescues it; recommendations
  // folds P probes under the eligibility filter (~70%).
  await measureShape(db, "SONIC broad", "anchored = 1", [], samples, 1, args, random);
  await measureShape(
    db,
    "SONIC narrow",
    "anchored = 1 and key = ?",
    [NARROW_KEY],
    samples,
    1,
    args,
    random,
  );
  await measureShape(
    db,
    "RECOMMENDATIONS",
    "anchored = 1 and certified = 0",
    [],
    samples,
    args.probes,
    args,
    random,
  );

  console.log(`\nDropping scratch table ${TABLE} …`);
  await db.execute(`drop table if exists ${TABLE}`);
  console.log("Done. Destroy the scratch DB now.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
