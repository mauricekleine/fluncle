/**
 * THROWAWAY SPIKE — build a 100k-row table with the vector index LIVE from the start
 * (the only order that works: see the report — CREATE INDEX over pre-existing rows is
 * a no-op locally and times out on hosted Turso), then measure ANN latency + recall@20
 * against an exact scan at true 100k scale.
 *
 * Corpus is CLUSTERED (k=9 centroids + noise), not uniform-random: real MuQ embeddings
 * of a DnB archive sit in clusters (Fluncle's galaxies), and uniform-random vectors in
 * 1024-d are a pathological worst case for any ANN graph (everything is equidistant).
 * Both corpora are measured so the recall band is honest.
 */
import { createClient } from "@libsql/client/web";

const db = createClient({ url: process.env.SPIKE_URL ?? "http://127.0.0.1:8911" });
const DIMS = 1024;
const N = Number(process.env.BUILD_N ?? 100_000);
const PARAMS = process.env.BUILD_PARAMS ?? "'metric=cosine','compress_neighbors=float1bit'";
const TABLE = process.env.BUILD_TABLE ?? "tracks_idx";
const CLUSTERED = process.env.BUILD_CLUSTERED !== "0";
const K = 9;

function raw(): Float32Array {
  const v = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i += 1) {
    v[i] = Math.random() * 2 - 1;
  }
  return v;
}
function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < DIMS; i += 1) {
    n += (v[i] ?? 0) ** 2;
  }
  const inv = 1 / Math.sqrt(n);
  for (let i = 0; i < DIMS; i += 1) {
    v[i] = (v[i] ?? 0) * inv;
  }
  return v;
}
const CENTROIDS = Array.from({ length: K }, () => normalize(raw()));
function vec(): Float32Array {
  if (!CLUSTERED) {
    return normalize(raw());
  }
  const c = CENTROIDS[Math.floor(Math.random() * K)] as Float32Array;
  const v = new Float32Array(DIMS);
  // 0.55 centroid + 0.45 noise => tight-ish clusters, the shape a genre archive has
  for (let i = 0; i < DIMS; i += 1) {
    v[i] = 0.55 * (c[i] ?? 0) + 0.45 * (Math.random() * 2 - 1);
  }
  return normalize(v);
}
const bytes = (v: Float32Array) => new Uint8Array(v.buffer.slice(0));
const text = (v: Float32Array) => JSON.stringify(Array.from(v));
const pct = (s: number[], p: number) =>
  s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;

await db.execute(`drop table if exists ${TABLE}`);
await db.execute(`create table ${TABLE} (
  id integer primary key, track_id text not null unique,
  title text not null, artist text not null, label text not null,
  embedding F32_BLOB(${DIMS}))`);
await db.execute(`create index ${TABLE}_vec on ${TABLE}(libsql_vector_idx(embedding, ${PARAMS}))`);
console.log(`table+index created (${PARAMS}), clustered=${CLUSTERED}, target N=${N}`);

const t0 = performance.now();
for (let s = 0; s < N; s += 200) {
  const size = Math.min(200, N - s);
  const args: unknown[] = [];
  const tup: string[] = [];
  for (let k = 0; k < size; k += 1) {
    tup.push("(?,?,?,?,?)");
    args.push(`spk_${s + k}`, `T${s + k}`, `A${(s + k) % 500}`, `L${(s + k) % 20}`, bytes(vec()));
  }
  await db.execute({
    args: args as never,
    sql: `insert into ${TABLE} (track_id,title,artist,label,embedding) values ${tup.join(",")}`,
  });
  if (s % 10_000 === 0) {
    const el = (performance.now() - t0) / 1000;
    console.log(
      `  ${s + size}/${N}  ${((s + size) / el).toFixed(0)} rows/s  elapsed ${el.toFixed(0)}s`,
    );
  }
}
const buildSec = (performance.now() - t0) / 1000;
console.log(
  `\nINDEXED BUILD: ${N} rows in ${(buildSec / 60).toFixed(1)} min (${(N / buildSec).toFixed(0)} rows/s, index live)`,
);

const annT: number[] = [];
const hydT: number[] = [];
const exT: number[] = [];
let recall = 0;
let payload = 0;
const PROBES = 25;
for (let i = 0; i < PROBES; i += 1) {
  const q = text(vec());
  let t = performance.now();
  const ann = await db.execute({
    args: [`${TABLE}_vec`, q],
    sql: "select id from vector_top_k(?, vector32(?), 20)",
  });
  annT.push(performance.now() - t);

  t = performance.now();
  const hyd = await db.execute({
    args: [`${TABLE}_vec`, q],
    sql: `select t.track_id,t.title,t.artist,t.label, vector_distance_cos(t.embedding, vector32(?2)) as dist
          from vector_top_k(?1, vector32(?2), 20) v join ${TABLE} t on t.id = v.id order by dist`,
  });
  hydT.push(performance.now() - t);
  payload = JSON.stringify(hyd.rows).length;

  t = performance.now();
  const exact = await db.execute({
    args: [q],
    sql: `select id from ${TABLE} order by vector_distance_cos(embedding, vector32(?1)) limit 20`,
  });
  exT.push(performance.now() - t);

  const truth = new Set(exact.rows.map((r) => Number((r as unknown as { id: number }).id)));
  recall +=
    ann.rows.filter((r) => truth.has(Number((r as unknown as { id: number }).id))).length / 20;
}
for (const a of [annT, hydT, exT]) {
  a.sort((x, y) => x - y);
}
console.log(`\n=== ${N} rows, ${DIMS}-d ===`);
console.log(
  `ANN top_k(20) ids only      p50=${pct(annT, 50).toFixed(1)}ms  p95=${pct(annT, 95).toFixed(1)}ms`,
);
console.log(
  `ANN top_k(20)+hydrate 1RT   p50=${pct(hydT, 50).toFixed(1)}ms  p95=${pct(hydT, 95).toFixed(1)}ms  payload=${payload}B`,
);
console.log(
  `EXACT full scan (no index)  p50=${pct(exT, 50).toFixed(1)}ms  p95=${pct(exT, 95).toFixed(1)}ms`,
);
console.log(`recall@20 vs exact: ${((recall / PROBES) * 100).toFixed(1)}%`);
