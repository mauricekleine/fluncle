/**
 * THROWAWAY SPIKE — the decisive measurement. Seed 100k rows into a SCRATCH Turso Cloud
 * db (never fluncle/fluncle-dev) with an F32_BLOB(1024) column and NO vector index, then
 * measure the two hot paths over the wire on `@libsql/client/web` — the exact driver the
 * Worker uses:
 *   1. exact NN:  order by vector_distance_cos(embedding, vector32(?)) limit 20
 *   2. FTS5 over title/artist/label
 * plus the cold-vs-warm split and the response-size cap.
 */
import { createClient } from "@libsql/client/web";

const db = createClient({
  authToken: process.env.SPIKE_CLOUD_TOKEN ?? "",
  url: process.env.SPIKE_CLOUD_URL ?? "",
});
const DIMS = 1024;
const N = Number(process.env.CLOUD_N ?? 100_000);
const K = 9;

const norm = (v: Float32Array) => {
  let n = 0;
  for (let i = 0; i < DIMS; i += 1) {
    n += (v[i] ?? 0) ** 2;
  }
  const inv = 1 / Math.sqrt(n);
  for (let i = 0; i < DIMS; i += 1) {
    v[i] = (v[i] ?? 0) * inv;
  }
  return v;
};
const raw = () => {
  const v = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i += 1) {
    v[i] = Math.random() * 2 - 1;
  }
  return norm(v);
};
const CENT = Array.from({ length: K }, () => raw());
const vec = () => {
  const c = CENT[Math.floor(Math.random() * K)] as Float32Array;
  const v = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i += 1) {
    v[i] = 0.55 * (c[i] ?? 0) + 0.45 * (Math.random() * 2 - 1);
  }
  return norm(v);
};
const B = (v: Float32Array) => new Uint8Array(v.buffer.slice(0));
const TX = (v: Float32Array) => JSON.stringify(Array.from(v));
const pct = (s: number[], p: number) =>
  s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;

const W = [
  "Halcyon",
  "Vertigo",
  "Rollers",
  "Terminal",
  "Ember",
  "Sonar",
  "Parallax",
  "Cascade",
  "Undertow",
  "Meridian",
];
const A = [
  "SubFocus",
  "Neurotheory",
  "AmenCartel",
  "GhostSignal",
  "VoidOrder",
  "LucidMethod",
  "IronDrift",
];
const L = [
  "Hospital Records",
  "Critical Music",
  "Metalheadz",
  "Shogun Audio",
  "RAM Records",
  "Dispatch Recordings",
];
const p = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)] as T;

await db.execute("drop table if exists arc");
await db.execute(`create table arc (
  id integer primary key, track_id text not null unique,
  title text not null, artist text not null, label text not null,
  embedding F32_BLOB(${DIMS}))`);

const t0 = performance.now();
for (let s = 0; s < N; s += 250) {
  const size = Math.min(250, N - s);
  const args: unknown[] = [];
  const tup: string[] = [];
  for (let k = 0; k < size; k += 1) {
    tup.push("(?,?,?,?,?)");
    args.push(`spk_${s + k}`, `${p(W)} ${p(W)}`, p(A), p(L), B(vec()));
  }
  await db.execute({
    args: args as never,
    sql: `insert into arc (track_id,title,artist,label,embedding) values ${tup.join(",")}`,
  });
  if (s % 20_000 === 0) {
    const el = (performance.now() - t0) / 1000;
    console.log(`  ${s + size}/${N}  ${((s + size) / el).toFixed(0)} rows/s`);
  }
}
const seedSec = (performance.now() - t0) / 1000;
console.log(
  `\nHOSTED SEED: ${N} rows in ${(seedSec / 60).toFixed(1)} min (${(N / seedSec).toFixed(0)} rows/s, no index)`,
);

// --- exact NN over the wire, COLD then WARM
const exT: number[] = [];
let payload = 0;
for (let i = 0; i < 25; i += 1) {
  const q = TX(vec());
  const t = performance.now();
  const r = await db.execute({
    args: [q],
    sql: `select track_id, title, artist, label, vector_distance_cos(embedding, vector32(?1)) as dist
          from arc order by dist limit 20`,
  });
  exT.push(performance.now() - t);
  payload = JSON.stringify(r.rows).length;
  if (i === 0) {
    console.log(`  COLD first exact scan: ${exT[0]?.toFixed(0)}ms`);
  }
}
const warm = exT.slice(1).sort((a, b) => a - b);
console.log(
  `EXACT NN @${N} over HTTP: p50=${pct(warm, 50).toFixed(0)}ms p95=${pct(warm, 95).toFixed(0)}ms min=${warm[0]?.toFixed(0)}ms max=${warm.at(-1)?.toFixed(0)}ms  payload=${payload}B  (1 round trip, 100% recall)`,
);

// --- FTS5 at 100k on hosted
await db.execute("drop table if exists arc_fts");
await db.execute(
  "create virtual table arc_fts using fts5(title, artist, label, content='arc', content_rowid='id')",
);
const tf = performance.now();
await db.execute("insert into arc_fts(arc_fts) values('rebuild')");
console.log(
  `\nHOSTED FTS5 rebuild over ${N} rows: ${((performance.now() - tf) / 1000).toFixed(1)}s`,
);

const q1: number[] = [];
const q2: number[] = [];
let ftsPayload = 0;
for (let i = 0; i < 25; i += 1) {
  let t = performance.now();
  const r = await db.execute({
    args: [["halcyon", "metalheadz", "neurotheory", "vertigo", "critical"][i % 5] as string],
    sql: `select t.track_id, t.title, t.artist, t.label from arc_fts f join arc t on t.id = f.rowid
          where arc_fts match ?1 order by bm25(arc_fts) limit 20`,
  });
  q1.push(performance.now() - t);
  ftsPayload = JSON.stringify(r.rows).length;

  t = performance.now();
  await db.execute({
    args: [["hal*", "met*", "neur*", "vert*", "crit*"][i % 5] as string],
    sql: `select t.track_id, t.title, t.artist, t.label from arc_fts f join arc t on t.id = f.rowid
          where arc_fts match ?1 order by bm25(arc_fts) limit 20`,
  });
  q2.push(performance.now() - t);
}
q1.sort((a, b) => a - b);
q2.sort((a, b) => a - b);
console.log(
  `FTS token  @${N} over HTTP: p50=${pct(q1, 50).toFixed(0)}ms p95=${pct(q1, 95).toFixed(0)}ms  payload=${ftsPayload}B`,
);
console.log(
  `FTS prefix @${N} over HTTP: p50=${pct(q2, 50).toFixed(0)}ms p95=${pct(q2, 95).toFixed(0)}ms`,
);

// --- how far can we push a batched exact scan (the mix-assistant may want top-100)?
for (const k of [50, 100]) {
  const t = performance.now();
  const r = await db.execute({
    args: [TX(vec()), k],
    sql: `select track_id, vector_distance_cos(embedding, vector32(?1)) as dist from arc order by dist limit ?2`,
  });
  console.log(
    `  exact top-${k}: ${(performance.now() - t).toFixed(0)}ms  payload=${JSON.stringify(r.rows).length}B`,
  );
}
