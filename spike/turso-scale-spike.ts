/**
 * THROWAWAY SPIKE — not production code, not wired into the app.
 *
 * Question: can Turso/libSQL hold a ~100k-track DnB archive and serve the two hot
 * paths from a Cloudflare Worker — (1) 1024-d MuQ vector similarity, (2) FTS over
 * title/artist/label?
 *
 * Everything here talks to a SCRATCH libSQL server over `@libsql/client/web` — the
 * exact HTTP driver + code path the deployed Worker uses. Never points at fluncle-dev
 * or prod.
 *
 *   turso dev --port 8911 --db-file /tmp/spike/spike.db
 *   bun spike/turso-scale-spike.ts seed 100000
 *   bun spike/turso-scale-spike.ts vecindex
 *   bun spike/turso-scale-spike.ts fts
 *   bun spike/turso-scale-spike.ts bench
 *   bun spike/turso-scale-spike.ts bruteforce
 *   bun spike/turso-scale-spike.ts writes
 */
import { createClient } from "@libsql/client/web";

const URL_ = process.env.SPIKE_URL ?? "http://127.0.0.1:8911";
const DB_FILE = process.env.SPIKE_DB ?? "/tmp/spike/spike.db";
const DIMS = 1024;

const db = createClient({ url: URL_ });

// ---------------------------------------------------------------- synthetic corpus

const ARTIST_A = [
  "Sub",
  "Neuro",
  "Amen",
  "Halo",
  "Bass",
  "Dark",
  "Lucid",
  "Ghost",
  "Rift",
  "Nova",
  "Solar",
  "Void",
  "Echo",
  "Iron",
  "Cold",
  "Deep",
  "Wave",
  "Static",
  "Prism",
  "Hollow",
];
const ARTIST_B = [
  "Focus",
  "Marka",
  "Dynamics",
  "Theory",
  "Complex",
  "Machine",
  "Kollektiv",
  "Signal",
  "Culture",
  "Audio",
  "Rebel",
  "Method",
  "Drift",
  "Circuit",
  "Order",
  "Vision",
  "State",
  "Cartel",
  "Union",
  "Program",
];
const TITLE_W = [
  "Rollers",
  "Halcyon",
  "Terminal",
  "Midnight",
  "Fracture",
  "Lucid",
  "Gravity",
  "Reprise",
  "Origin",
  "Twilight",
  "Cascade",
  "Phantom",
  "Overdrive",
  "Sublime",
  "Retrograde",
  "Momentum",
  "Threshold",
  "Aurora",
  "Nightfall",
  "Pressure",
  "Distant",
  "Frequency",
  "Sonar",
  "Meridian",
  "Vertigo",
  "Ember",
  "Kinetic",
  "Parallax",
  "Solstice",
  "Undertow",
];
const LABELS = [
  "Hospital Records",
  "Critical Music",
  "Metalheadz",
  "Shogun Audio",
  "RAM Records",
  "Blu Mar Ten Music",
  "Dispatch Recordings",
  "Vision Recordings",
  "Flexout Audio",
  "Overview Music",
  "Soulvent Records",
  "1985 Music",
  "Horizons Music",
  "Lifted Music",
  "Integral Records",
  "Fokuz Recordings",
  "Liquicity Records",
  "V Recordings",
  "Innerground",
  "Signature Recordings",
];

// deterministic PRNG so a rerun seeds an identical corpus
let seed = 0x9e3779b9;
function rnd(): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 1_000_000) / 1_000_000;
}
function pick<T>(xs: T[]): T {
  return xs[Math.floor(rnd() * xs.length)] as T;
}
function gauss(): number {
  const u = Math.max(rnd(), 1e-9);
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** A random-but-L2-NORMALIZED float32 vector — the shape MuQ actually emits. */
function makeVector(): Float32Array {
  const v = new Float32Array(DIMS);
  let norm = 0;
  for (let i = 0; i < DIMS; i += 1) {
    const g = gauss();
    v[i] = g;
    norm += g * g;
  }
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < DIMS; i += 1) {
    v[i] = (v[i] ?? 0) * inv;
  }
  return v;
}

function makeRow(i: number) {
  const vec = makeVector();
  const title = `${pick(TITLE_W)} ${pick(TITLE_W)}${rnd() < 0.25 ? ` (${pick(TITLE_W)} VIP)` : ""}`;
  const artist =
    rnd() < 0.3
      ? `${pick(ARTIST_A)}${pick(ARTIST_B)} & ${pick(ARTIST_A)}${pick(ARTIST_B)}`
      : `${pick(ARTIST_A)}${pick(ARTIST_B)}`;
  return {
    artist,
    // blob: raw little-endian f32 bytes — what an F32_BLOB column stores natively
    blob: new Uint8Array(vec.buffer.slice(0)),
    // json: JSON.stringify of the f32-rounded doubles — byte-for-byte the shape the
    // real `tracks.embedding_json` column holds today (prod avg = 21,804 bytes/row)
    json: JSON.stringify(Array.from(vec)),
    label: pick(LABELS),
    title,
    trackId: `spk_${i.toString().padStart(7, "0")}`,
    vec,
  };
}

// ---------------------------------------------------------------- helpers

function fileSize(path: string): number {
  try {
    return Bun.file(path).size;
  } catch {
    return 0;
  }
}
function dbBytes(): number {
  return fileSize(DB_FILE) + fileSize(`${DB_FILE}-wal`);
}
function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function pct(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i] ?? 0;
}
async function timeIt<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
}
async function measure(
  label: string,
  iterations: number,
  fn: (i: number) => Promise<unknown>,
): Promise<void> {
  await fn(-1); // warm
  const times: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const [, ms] = await timeIt(() => fn(i));
    times.push(ms);
  }
  times.sort((a, b) => a - b);
  console.log(
    `${label.padEnd(52)} n=${String(iterations).padStart(3)}  p50=${pct(times, 50).toFixed(1).padStart(8)}ms  p95=${pct(times, 95).toFixed(1).padStart(8)}ms  min=${times[0]?.toFixed(1)}ms  max=${times.at(-1)?.toFixed(1)}ms`,
  );
}

// ---------------------------------------------------------------- phases

async function seedPhase(n: number) {
  await db.execute("drop table if exists tracks_spike");
  await db.execute(`create table tracks_spike (
    id integer primary key,
    track_id text not null unique,
    title text not null,
    artist text not null,
    label text not null,
    embedding F32_BLOB(${DIMS}),
    embedding_json text
  )`);

  const before = dbBytes();
  const batch = 250;
  const t0 = performance.now();
  let jsonBytes = 0;

  for (let start = 0; start < n; start += batch) {
    const size = Math.min(batch, n - start);
    const args: unknown[] = [];
    const tuples: string[] = [];
    for (let k = 0; k < size; k += 1) {
      const row = makeRow(start + k);
      jsonBytes += row.json.length;
      tuples.push("(?,?,?,?,?,?)");
      args.push(row.trackId, row.title, row.artist, row.label, row.blob, row.json);
    }
    await db.execute({
      args: args as never,
      sql: `insert into tracks_spike (track_id, title, artist, label, embedding, embedding_json) values ${tuples.join(",")}`,
    });
    if ((start / batch) % 40 === 0) {
      const done = start + size;
      const el = (performance.now() - t0) / 1000;
      console.log(`  seeded ${done}/${n}  ${(done / el).toFixed(0)} rows/s  ${mb(dbBytes())}`);
    }
  }

  const elapsed = (performance.now() - t0) / 1000;
  console.log(`\nSEED: ${n} rows in ${elapsed.toFixed(1)}s (${(n / elapsed).toFixed(0)} rows/s)`);
  console.log(`  avg embedding_json bytes/row: ${(jsonBytes / n).toFixed(0)}`);
  console.log(`  db grew ${mb(before)} -> ${mb(dbBytes())}`);
}

async function vecIndexPhase() {
  const before = dbBytes();
  const [, ms] = await timeIt(() =>
    db.execute(
      "create index tracks_spike_vec on tracks_spike(libsql_vector_idx(embedding, 'metric=cosine'))",
    ),
  );
  const after = dbBytes();
  console.log(`VECTOR INDEX build: ${(ms / 1000).toFixed(1)}s`);
  console.log(`  db ${mb(before)} -> ${mb(after)}  (index cost ~${mb(after - before)})`);
}

async function ftsPhase() {
  const before = dbBytes();
  await db.execute("drop table if exists tracks_fts");
  await db.execute(
    "create virtual table tracks_fts using fts5(title, artist, label, content='tracks_spike', content_rowid='id')",
  );
  const [, ms] = await timeIt(() =>
    db.execute("insert into tracks_fts(tracks_fts) values('rebuild')"),
  );
  const after = dbBytes();
  console.log(`FTS5 build (rebuild over ${await count()} rows): ${(ms / 1000).toFixed(1)}s`);
  console.log(`  db ${mb(before)} -> ${mb(after)}  (fts index cost ~${mb(after - before)})`);
}

async function count(): Promise<number> {
  const r = await db.execute("select count(*) as c from tracks_spike");
  return Number((r.rows[0] as unknown as { c: number }).c);
}

function toVecText(v: Float32Array): string {
  return JSON.stringify(Array.from(v));
}

async function benchPhase() {
  const n = await count();
  console.log(
    `\n=== BENCH at ${n} rows (driver: @libsql/client/web, HTTP — the Worker path) ===\n`,
  );

  const probes = Array.from({ length: 30 }, () => toVecText(makeVector()));

  // --- (A) ANN via vector_top_k, ids only — one round trip
  await measure("VEC ann vector_top_k(20) ids only", 30, async (i) =>
    db.execute({
      args: ["tracks_spike_vec", probes[Math.max(i, 0) % probes.length] as string],
      sql: "select id from vector_top_k(?, vector32(?), 20)",
    }),
  );

  // --- (B) ANN + hydration in ONE round trip (join back to the table)
  await measure("VEC ann top_k(20) + hydrate JOIN (1 round trip)", 30, async (i) => {
    const r = await db.execute({
      args: ["tracks_spike_vec", probes[Math.max(i, 0) % probes.length] as string],
      sql: `select t.track_id, t.title, t.artist, t.label,
                   vector_distance_cos(t.embedding, vector32(?2)) as dist
            from vector_top_k(?1, vector32(?2), 20) v
            join tracks_spike t on t.id = v.id
            order by dist`,
    });
    return r.rows.length;
  });

  // payload size of the hot query
  const one = await db.execute({
    args: ["tracks_spike_vec", probes[0] as string],
    sql: `select t.track_id, t.title, t.artist, t.label,
                 vector_distance_cos(t.embedding, vector32(?2)) as dist
          from vector_top_k(?1, vector32(?2), 20) v join tracks_spike t on t.id = v.id order by dist`,
  });
  console.log(
    `  -> rows=${one.rows.length}  hydrated payload ≈ ${JSON.stringify(one.rows).length} bytes\n`,
  );

  // --- (C) exact brute force IN SQL (full scan, no index) — the server-side ceiling
  for (const limitN of [10_000, 50_000, n]) {
    await measure(`VEC exact SQL scan vector_distance_cos @${limitN}`, 10, async (i) =>
      db.execute({
        args: [probes[Math.max(i, 0) % probes.length] as string, limitN],
        sql: `select track_id from tracks_spike where id <= ?2
              order by vector_distance_cos(embedding, vector32(?1)) limit 20`,
      }),
    );
  }

  console.log("");

  // --- (D) FTS5
  const tokens = ["halcyon", "metalheadz", "neurofocus", "vertigo", "critical"];
  await measure("FTS token match + bm25 + limit 20", 30, async (i) =>
    db.execute({
      args: [tokens[Math.max(i, 0) % tokens.length] as string],
      sql: `select t.track_id, t.title, t.artist, t.label
            from tracks_fts f join tracks_spike t on t.id = f.rowid
            where tracks_fts match ?1 order by bm25(tracks_fts) limit 20`,
    }),
  );
  const prefixes = ["hal*", "neur*", "met*", "vert*", "crit*", "sub*"];
  await measure("FTS prefix match (typeahead) + bm25 + limit 20", 30, async (i) =>
    db.execute({
      args: [prefixes[Math.max(i, 0) % prefixes.length] as string],
      sql: `select t.track_id, t.title, t.artist, t.label
            from tracks_fts f join tracks_spike t on t.id = f.rowid
            where tracks_fts match ?1 order by bm25(tracks_fts) limit 20`,
    }),
  );
  await measure("FTS 2-token AND + bm25 + limit 20", 30, async () =>
    db.execute({
      args: ["halcyon vertigo"],
      sql: `select t.track_id from tracks_fts f join tracks_spike t on t.id = f.rowid
            where tracks_fts match ?1 order by bm25(tracks_fts) limit 20`,
    }),
  );
  await measure("FTS column filter artist:neur* + limit 20", 30, async () =>
    db.execute({
      args: ["artist:neur*"],
      sql: `select t.track_id from tracks_fts f join tracks_spike t on t.id = f.rowid
            where tracks_fts match ?1 order by bm25(tracks_fts) limit 20`,
    }),
  );
  await measure("LIKE '%…%' scan (the no-FTS baseline)", 5, async () =>
    db.execute({
      args: ["%halcyon%"],
      sql: "select track_id from tracks_spike where title like ?1 limit 20",
    }),
  );

  const fr = await db.execute({
    args: ["hal*"],
    sql: `select t.track_id, t.title, t.artist, t.label from tracks_fts f
          join tracks_spike t on t.id = f.rowid where tracks_fts match ?1
          order by bm25(tracks_fts) limit 20`,
  });
  console.log(`  -> fts payload ≈ ${JSON.stringify(fr.rows).length} bytes\n`);
}

/** The CURRENT production shape: pull every embedding_json into JS, cosine there. */
async function bruteForcePhase() {
  const total = await count();
  console.log(`\n=== BRUTE FORCE (today's rankBySimilarity path) — table has ${total} rows ===\n`);
  const target = makeVector();
  const targetArr = Array.from(target);

  for (const n of [1_000, 5_000, 10_000, 25_000, 50_000, 100_000]) {
    if (n > total) {
      continue;
    }
    try {
      const t0 = performance.now();
      const r = await db.execute({
        args: [n],
        sql: "select track_id, embedding_json from tracks_spike where id <= ?1",
      });
      const tFetch = performance.now() - t0;

      let payload = 0;
      const t1 = performance.now();
      let best = -2;
      let bestId = "";
      for (const row of r.rows as unknown as { embedding_json: string; track_id: string }[]) {
        payload += row.embedding_json.length;
        const v = JSON.parse(row.embedding_json) as number[];
        let dot = 0;
        for (let i = 0; i < DIMS; i += 1) {
          dot += (targetArr[i] ?? 0) * (v[i] ?? 0);
        }
        if (dot > best) {
          best = dot;
          bestId = row.track_id;
        }
      }
      const tRank = performance.now() - t1;
      const rss = process.memoryUsage().rss;

      console.log(
        `N=${String(n).padStart(6)}  fetch=${tFetch.toFixed(0).padStart(6)}ms  parse+cosine=${tRank.toFixed(0).padStart(6)}ms  total=${(tFetch + tRank).toFixed(0).padStart(6)}ms  payload=${mb(payload).padStart(9)}  peakRSS=${mb(rss)}  (top=${bestId})`,
      );
    } catch (e) {
      console.log(`N=${String(n).padStart(6)}  DIED: ${String(e).slice(0, 160)}`);
    }
    Bun.gc(true);
  }
  console.log(
    "\n  (a Cloudflare Worker isolate caps at 128 MB memory and 30 s CPU on the paid plan)",
  );
}

/** Can the enrichment pipeline bulk-insert while the read path is hot? */
async function writesPhase() {
  console.log("\n=== WRITE CONTENTION: bulk insert vs. the hot read path ===\n");
  const base = await count();
  const probes = Array.from({ length: 20 }, () => toVecText(makeVector()));

  const readTimes: number[] = [];
  let stop = false;
  const reader = (async () => {
    let i = 0;
    while (!stop) {
      const t = performance.now();
      await db.execute({
        args: ["tracks_spike_vec", probes[i % probes.length] as string],
        sql: `select t.track_id from vector_top_k(?1, vector32(?2), 20) v join tracks_spike t on t.id = v.id`,
      });
      readTimes.push(performance.now() - t);
      i += 1;
    }
  })();

  const rows = 2_000;
  const batch = 100;
  const t0 = performance.now();
  const batchTimes: number[] = [];
  for (let start = 0; start < rows; start += batch) {
    const args: unknown[] = [];
    const tuples: string[] = [];
    for (let k = 0; k < batch; k += 1) {
      const row = makeRow(base + start + k + 1_000_000);
      tuples.push("(?,?,?,?,?,?)");
      args.push(row.trackId, row.title, row.artist, row.label, row.blob, row.json);
    }
    const t = performance.now();
    await db.execute({
      args: args as never,
      sql: `insert into tracks_spike (track_id, title, artist, label, embedding, embedding_json) values ${tuples.join(",")}`,
    });
    batchTimes.push(performance.now() - t);
  }
  const writeMs = performance.now() - t0;
  stop = true;
  await reader;

  batchTimes.sort((a, b) => a - b);
  readTimes.sort((a, b) => a - b);
  console.log(
    `WRITE ${rows} rows (with vector idx + fts triggers absent) in ${(writeMs / 1000).toFixed(1)}s = ${(rows / (writeMs / 1000)).toFixed(0)} rows/s`,
  );
  console.log(
    `  insert batch(${batch}) p50=${pct(batchTimes, 50).toFixed(0)}ms p95=${pct(batchTimes, 95).toFixed(0)}ms`,
  );
  console.log(
    `  CONCURRENT ann reads: n=${readTimes.length} p50=${pct(readTimes, 50).toFixed(1)}ms p95=${pct(readTimes, 95).toFixed(1)}ms max=${readTimes.at(-1)?.toFixed(1)}ms  (0 lock errors — any would have thrown)`,
  );
  await db.execute("delete from tracks_spike where id > ?", [base] as never);
}

const [phase, arg] = process.argv.slice(2);
if (phase === "seed") {
  await seedPhase(Number(arg ?? 100_000));
} else if (phase === "vecindex") {
  await vecIndexPhase();
} else if (phase === "fts") {
  await ftsPhase();
} else if (phase === "bench") {
  await benchPhase();
} else if (phase === "bruteforce") {
  await bruteForcePhase();
} else if (phase === "writes") {
  await writesPhase();
} else {
  console.log("phases: seed <n> | vecindex | fts | bench | bruteforce | writes");
}
