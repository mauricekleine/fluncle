/**
 * THROWAWAY SPIKE — runs against a SCRATCH Turso Cloud DB (`fluncle-scale-spike`),
 * never fluncle / fluncle-dev. Answers the questions that are server-VERSION specific
 * and therefore cannot be answered by the local `turso dev` (sqld 0.24.31):
 *   - does the hosted server backfill a vector index over pre-existing rows?
 *   - what is the hosted response-size cap?
 *   - insert throughput with the vector index live
 *   - real over-the-wire ANN + FTS latency on the HTTP driver the Worker uses
 *
 * Creds come from `turso db show --url` / `turso db tokens create` at run time; nothing
 * is written to disk.
 */
import { createClient } from "@libsql/client/web";

const url = process.env.SPIKE_CLOUD_URL ?? "";
const authToken = process.env.SPIKE_CLOUD_TOKEN ?? "";
const DIMS = 1024;
const N = Number(process.env.CLOUD_N ?? 2000);
const db = createClient({ authToken, url });

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
const W = ["Halcyon", "Vertigo", "Rollers", "Terminal", "Ember", "Sonar", "Parallax", "Cascade"];
const A = ["SubFocus", "Neurotheory", "AmenCartel", "GhostSignal", "VoidOrder"];
const L = ["Hospital Records", "Critical Music", "Metalheadz", "Shogun Audio"];
const p = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)] as T;

async function insert(table: string, from: number, n: number): Promise<number> {
  const t0 = performance.now();
  for (let s = 0; s < n; s += 100) {
    const args: unknown[] = [];
    const tup: string[] = [];
    for (let k = 0; k < 100; k += 1) {
      const v = vec();
      tup.push("(?,?,?,?,?,?)");
      args.push(
        `spk_${from + s + k}`,
        `${p(W)} ${p(W)}`,
        p(A),
        p(L),
        bytes(v),
        JSON.stringify(Array.from(v)),
      );
    }
    await db.execute({
      args: args as never,
      sql: `insert into ${table} (track_id,title,artist,label,embedding,embedding_json) values ${tup.join(",")}`,
    });
  }
  return (performance.now() - t0) / 1000;
}
const ddl = (t: string) => `create table ${t} (
  id integer primary key, track_id text not null unique, title text not null,
  artist text not null, label text not null,
  embedding F32_BLOB(${DIMS}), embedding_json text)`;

console.log(`=== TURSO CLOUD (scratch db, ${DIMS}-d, N=${N}) ===\n`);
console.log("server:", JSON.stringify((await db.execute("select sqlite_version() as v")).rows[0]));

// ---- 1. does CREATE INDEX backfill pre-existing rows on the HOSTED server?
await db.execute("drop table if exists t_after");
await db.execute(ddl("t_after"));
const insNoIdx = await insert("t_after", 0, N);
console.log(
  `\ninsert ${N} rows, NO index:   ${insNoIdx.toFixed(1)}s = ${(N / insNoIdx).toFixed(0)} rows/s`,
);
const tIdx = performance.now();
await db.execute(
  "create index t_after_vec on t_after(libsql_vector_idx(embedding, 'metric=cosine'))",
);
const idxMs = performance.now() - tIdx;
const shadow = Number(
  (await db.execute("select count(*) as c from t_after_vec_shadow")).rows[0]?.c ?? 0,
);
const probe = text(vec());
const annAfter = await db.execute({
  args: ["t_after_vec", probe],
  sql: "select id from vector_top_k(?, vector32(?), 20)",
});
console.log(
  `CREATE INDEX on ${N} existing rows: ${(idxMs / 1000).toFixed(1)}s -> shadow rows=${shadow}, vector_top_k returned ${annAfter.rows.length} rows  => BACKFILL ${shadow > 0 && annAfter.rows.length > 0 ? "WORKS" : "SILENTLY EMPTY"}`,
);

// ---- 2. index-FIRST insert throughput (the write penalty)
await db.execute("drop table if exists t_first");
await db.execute(ddl("t_first"));
await db.execute(
  "create index t_first_vec on t_first(libsql_vector_idx(embedding, 'metric=cosine'))",
);
const insIdx = await insert("t_first", 0, N);
console.log(
  `insert ${N} rows, index LIVE:  ${insIdx.toFixed(1)}s = ${(N / insIdx).toFixed(0)} rows/s   (${(insIdx / insNoIdx).toFixed(1)}x slower than no-index)`,
);

// ---- 3. ANN latency + recall over the wire (whichever table actually has an index)
const table = shadow > 0 ? "t_after" : "t_first";
const idx = shadow > 0 ? "t_after_vec" : "t_first_vec";
const annT: number[] = [];
const hydT: number[] = [];
let recall = 0;
let payload = 0;
for (let i = 0; i < 20; i += 1) {
  const q = text(vec());
  let t0 = performance.now();
  const ann = await db.execute({
    args: [idx, q],
    sql: "select id from vector_top_k(?, vector32(?), 20)",
  });
  annT.push(performance.now() - t0);
  t0 = performance.now();
  const hyd = await db.execute({
    args: [idx, q],
    sql: `select t.track_id,t.title,t.artist,t.label, vector_distance_cos(t.embedding, vector32(?2)) as dist
          from vector_top_k(?1, vector32(?2), 20) v join ${table} t on t.id = v.id order by dist`,
  });
  hydT.push(performance.now() - t0);
  payload = JSON.stringify(hyd.rows).length;
  const exact = await db.execute({
    args: [q],
    sql: `select id from ${table} order by vector_distance_cos(embedding, vector32(?1)) limit 20`,
  });
  const truth = new Set(exact.rows.map((r) => Number((r as unknown as { id: number }).id)));
  recall +=
    ann.rows.filter((r) => truth.has(Number((r as unknown as { id: number }).id))).length / 20;
}
annT.sort((a, b) => a - b);
hydT.sort((a, b) => a - b);
console.log(
  `\nANN top_k(20) ids only        p50=${pct(annT, 50).toFixed(0)}ms p95=${pct(annT, 95).toFixed(0)}ms`,
);
console.log(
  `ANN top_k(20)+hydrate (1 RT)  p50=${pct(hydT, 50).toFixed(0)}ms p95=${pct(hydT, 95).toFixed(0)}ms  payload=${payload}B  recall@20=${((recall / 20) * 100).toFixed(0)}%`,
);

// ---- 4. exact server-side scan (no index) over the wire
const exT: number[] = [];
for (let i = 0; i < 10; i += 1) {
  const q = text(vec());
  const t0 = performance.now();
  await db.execute({
    args: [q],
    sql: `select track_id from t_after order by vector_distance_cos(embedding, vector32(?1)) limit 20`,
  });
  exT.push(performance.now() - t0);
}
exT.sort((a, b) => a - b);
console.log(
  `EXACT sql scan @${N} (no idx)   p50=${pct(exT, 50).toFixed(0)}ms p95=${pct(exT, 95).toFixed(0)}ms`,
);

// ---- 5. hosted RESPONSE-SIZE cap on the brute-force (embedding_json) select
let lo = 1;
let hi = N;
const tryN = async (n: number) => {
  try {
    const r = await db.execute({
      args: [n],
      sql: "select track_id, embedding_json from t_after where id <= ?1",
    });
    let b = 0;
    for (const row of r.rows as unknown as { embedding_json: string }[]) {
      b += row.embedding_json.length;
    }
    return b;
  } catch {
    return -1;
  }
};
while (lo < hi) {
  const mid = Math.floor((lo + hi + 1) / 2);
  if ((await tryN(mid)) > 0) {
    lo = mid;
  } else {
    hi = mid - 1;
  }
}
const capBytes = await tryN(lo);
console.log(
  `\nBRUTE-FORCE cap: max ${lo} rows of embedding_json (${(capBytes / 1024 / 1024).toFixed(2)} MiB); ${lo + 1} => error`,
);

// ---- 6. FTS5 on the hosted server
await db.execute("drop table if exists t_fts");
await db.execute(
  "create virtual table t_fts using fts5(title, artist, label, content='t_after', content_rowid='id')",
);
const tf = performance.now();
await db.execute("insert into t_fts(t_fts) values('rebuild')");
console.log(`FTS5 rebuild over ${N} rows: ${((performance.now() - tf) / 1000).toFixed(1)}s`);
const ftsT: number[] = [];
for (let i = 0; i < 20; i += 1) {
  const t0 = performance.now();
  await db.execute({
    args: [["hal*", "vert*", "metalheadz", "neuro*", "sonar"][i % 5] as string],
    sql: `select t.track_id,t.title,t.artist from t_fts f join t_after t on t.id=f.rowid
          where t_fts match ?1 order by bm25(t_fts) limit 20`,
  });
  ftsT.push(performance.now() - t0);
}
ftsT.sort((a, b) => a - b);
console.log(
  `FTS query (token+prefix, 1 RT)  p50=${pct(ftsT, 50).toFixed(0)}ms p95=${pct(ftsT, 95).toFixed(0)}ms`,
);
