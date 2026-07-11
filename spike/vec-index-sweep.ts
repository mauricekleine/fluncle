/** THROWAWAY SPIKE — sweep libsql_vector_idx params for insert throughput / query latency / recall. */
import { createClient } from "@libsql/client/web";

const db = createClient({ url: process.env.SPIKE_URL ?? "http://127.0.0.1:8911" });
const DIMS = 1024;
const N = Number(process.env.SWEEP_N ?? 2000);

function vec(): Float32Array {
  const v = new Float32Array(DIMS);
  let n = 0;
  for (let i = 0; i < DIMS; i += 1) {
    const g = Math.random() * 2 - 1;
    v[i] = g;
    n += g * g;
  }
  const inv = 1 / Math.sqrt(n);
  for (let i = 0; i < DIMS; i += 1) {
    v[i] = (v[i] ?? 0) * inv;
  }
  return v;
}
const bytes = (v: Float32Array) => new Uint8Array(v.buffer.slice(0));
const text = (v: Float32Array) => JSON.stringify(Array.from(v));
const pct = (s: number[], p: number) =>
  s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;

const CONFIGS: [string, string][] = [
  ["default", "'metric=cosine'"],
  ["float8", "'metric=cosine','compress_neighbors=float8'"],
  ["float1bit", "'metric=cosine','compress_neighbors=float1bit'"],
  ["f1bit+nb8", "'metric=cosine','compress_neighbors=float1bit','max_neighbors=8'"],
  ["f8+nb8", "'metric=cosine','compress_neighbors=float8','max_neighbors=8'"],
];

console.log(`sweep: ${N} rows/config, ${DIMS}-d L2-normalized f32\n`);

for (const [name, params] of CONFIGS) {
  const t = `sw_${name.replace(/\W/g, "")}`;
  await db.execute(`drop table if exists ${t}`);
  await db.execute(`create table ${t} (id integer primary key, embedding F32_BLOB(${DIMS}))`);
  let idxMs = 0;
  try {
    const t0 = performance.now();
    await db.execute(`create index ${t}_idx on ${t}(libsql_vector_idx(embedding, ${params}))`);
    idxMs = performance.now() - t0;
  } catch (e) {
    console.log(`${name.padEnd(11)} INDEX CREATE FAILED: ${String(e).slice(0, 110)}`);
    continue;
  }

  const t0 = performance.now();
  for (let s = 0; s < N; s += 100) {
    const args: unknown[] = [];
    const tup: string[] = [];
    for (let k = 0; k < 100; k += 1) {
      tup.push("(?)");
      args.push(bytes(vec()));
    }
    await db.execute({
      args: args as never,
      sql: `insert into ${t} (embedding) values ${tup.join(",")}`,
    });
  }
  const insSec = (performance.now() - t0) / 1000;

  // query latency + recall@20 vs exact scan
  const times: number[] = [];
  let recall = 0;
  const PROBES = 15;
  for (let p = 0; p < PROBES; p += 1) {
    const q = text(vec());
    const q0 = performance.now();
    const ann = await db.execute({
      args: [`${t}_idx`, q],
      sql: `select id from vector_top_k(?, vector32(?), 20)`,
    });
    times.push(performance.now() - q0);
    const exact = await db.execute({
      args: [q],
      sql: `select id from ${t} order by vector_distance_cos(embedding, vector32(?1)) limit 20`,
    });
    const truth = new Set(exact.rows.map((r) => Number((r as unknown as { id: number }).id)));
    const hit = ann.rows.filter((r) =>
      truth.has(Number((r as unknown as { id: number }).id)),
    ).length;
    recall += hit / 20;
  }
  times.sort((a, b) => a - b);
  console.log(
    `${name.padEnd(11)} idxCreate=${idxMs.toFixed(0).padStart(4)}ms  insert=${(N / insSec).toFixed(0).padStart(5)} rows/s (${insSec.toFixed(0)}s/${N})  ann p50=${pct(times, 50).toFixed(1)}ms p95=${pct(times, 95).toFixed(1)}ms  recall@20=${((recall / PROBES) * 100).toFixed(1)}%`,
  );
  await db.execute(`drop table ${t}`);
}
