// recall-ab.ts — Proof B (the PRIMARY gate). Recall of Vectorize ANN vs the
// EXACT cosine scan, over REAL embeddings, self-contained.
//
//   bun run recall-ab.ts --file ./data/real-export.ndjson --worker https://<url> \
//                        [--probes 200] [--seed 1] [--token <secret>] [--load]
//
// GROUND TRUTH = exact brute-force cosine top-K computed LOCALLY over the full
// export (the export contains every vector, so no DB is needed). TEST ARM = the
// same probes queried against a REAL Vectorize index holding the same vectors.
// METRIC = overlap@K = |exactTopK ∩ vectorizeTopK| / K, meaned over the probes,
// reported per surface (global / filtered) × mode (approximate / high-precision).
//
// Export line shape (produced read-only from prod Turso by the operator):
//   { "trackId": string, "embedding": number[1024],
//     "key": string, "bpm": number, "anchored": boolean, "certified": boolean }

import { parseArgs } from "node:util";

import { byteLength, MAX_ID_BYTES } from "./lib/metadata";
import { mean, overlapAtK } from "./lib/overlap";
import {
  chunk,
  type DescribeResponse,
  type QueryResponse,
  type RealExportRecord,
} from "./lib/protocol";
import { mulberry32 } from "./lib/prng";
import { cosine, magnitude } from "./lib/vector";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    load: { type: "boolean" },
    probes: { type: "string" },
    seed: { type: "string" },
    token: { type: "string" },
    worker: { type: "string" },
  },
});

if (!values.file) {
  throw new Error("--file <real-export.ndjson> is required");
}
// Bind a narrowed const — TS does not carry the guard's narrowing into main().
const file: string = values.file;
const worker = (values.worker ?? process.env.SPIKE_WORKER_URL ?? "").replace(/\/$/, "");
if (!worker) {
  console.error("--worker <url> (or SPIKE_WORKER_URL) is required");
  process.exit(1);
}
const probeCount = values.probes ? Number(values.probes) : 200;
const seed = values.seed ? Number(values.seed) : 1;
const token = values.token ?? process.env.SPIKE_TOKEN;
const K_SET = [10, 50] as const;
const MAX_K = 50;

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (token) {
    h["x-spike-token"] = token;
  }
  return h;
}

type Row = {
  id: string;
  vec: Float32Array;
  mag: number;
  key: string;
  bpm: number;
  anchored: boolean;
  certified: boolean;
};

function loadExport(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    const r = JSON.parse(t) as RealExportRecord;
    const vec = Float32Array.from(r.embedding);
    if (byteLength(r.trackId) > MAX_ID_BYTES) {
      throw new Error(`trackId exceeds ${MAX_ID_BYTES} bytes: ${r.trackId}`);
    }
    rows.push({
      anchored: r.anchored,
      bpm: r.bpm,
      certified: r.certified,
      id: r.trackId,
      key: r.key,
      mag: magnitude(vec),
      vec,
    });
  }
  return rows;
}

/** Exact cosine top-K over `candidateIdx`, excluding `selfIdx`. Returns ids. */
function exactTopK(
  rows: Row[],
  probe: Row,
  candidateIdx: number[],
  selfIdx: number,
  k: number,
): string[] {
  const best: { idx: number; score: number }[] = [];
  let worst = -Infinity;
  for (const idx of candidateIdx) {
    if (idx === selfIdx) {
      continue;
    }
    const score = cosine(probe.vec, rows[idx]?.vec ?? probe.vec);
    if (best.length < k) {
      best.push({ idx, score });
      if (best.length === k) {
        worst = Math.min(...best.map((b) => b.score));
      }
    } else if (score > worst) {
      // Replace current minimum.
      let minAt = 0;
      for (let i = 1; i < best.length; i++) {
        if ((best[i]?.score ?? Infinity) < (best[minAt]?.score ?? Infinity)) {
          minAt = i;
        }
      }
      best[minAt] = { idx, score };
      worst = Math.min(...best.map((b) => b.score));
    }
  }
  best.sort((a, b) => b.score - a.score);
  return best.map((b) => rows[b.idx]?.id ?? "");
}

async function vectorizeTopK(
  probe: Row,
  filter: Record<string, unknown> | undefined,
  highPrecision: boolean,
): Promise<string[]> {
  // High-precision (returnValues:true) caps topK at 50 and cannot over-fetch;
  // approximate can, so it requests one extra to survive self-exclusion.
  const topK = highPrecision ? MAX_K : MAX_K + 1;
  const res = await fetch(`${worker}/admin/query`, {
    body: JSON.stringify({
      index: "tracks",
      topK,
      vector: Array.from(probe.vec),
      ...(filter ? { filter } : {}),
      ...(highPrecision ? { returnValues: true } : { returnMetadata: "indexed" }),
    }),
    headers: headers(),
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`query failed ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as QueryResponse;
  return body.matches
    .map((m) => m.id)
    .filter((id) => id !== probe.id)
    .slice(0, MAX_K);
}

async function describe(): Promise<DescribeResponse> {
  const res = await fetch(`${worker}/describe?index=tracks`);
  return (await res.json()) as DescribeResponse;
}

async function loadRows(rows: Row[]): Promise<void> {
  console.log(`--load: upserting ${rows.length} real vectors into SPIKE_TRACKS…`);
  const records = rows.map((r) => ({
    id: r.id,
    metadata: { anchored: r.anchored, bpm: r.bpm, certified: r.certified, key: r.key },
    values: Array.from(r.vec),
  }));
  let done = 0;
  for (const batch of chunk(records, 1000)) {
    const res = await fetch(`${worker}/admin/load?index=tracks`, {
      body: JSON.stringify({ index: "tracks", vectors: batch }),
      headers: headers(),
      method: "POST",
    });
    if (!res.ok) {
      throw new Error(`load failed ${res.status}: ${await res.text()}`);
    }
    done += batch.length;
    if (done % 10_000 === 0 || batch.length < 1000) {
      console.log(`  upserted ${done}/${records.length}`);
    }
  }
  // Wait for consistency.
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    await Bun.sleep(5000);
    const info = await describe();
    console.log(`  vectorCount=${info.vectorCount}/${rows.length}`);
    if (info.vectorCount >= rows.length) {
      break;
    }
  }
}

type Cell = { approx: number[]; high: number[] };
type SurfaceResults = { 10: Cell; 50: Cell };
function emptyCell(): Cell {
  return { approx: [], high: [] };
}

async function main(): Promise<void> {
  console.log(`reading export ${file}…`);
  const rows = loadExport(await Bun.file(file).text());
  console.log(`  ${rows.length} vectors loaded (dim=${rows[0]?.vec.length ?? 0}).`);
  if (rows.length < probeCount + 2) {
    throw new Error(`export too small (${rows.length}) for ${probeCount} probes`);
  }

  if (values.load) {
    await loadRows(rows);
  }

  // Filter index: anchored rows grouped by Camelot key (for the filtered surface's
  // exact candidate set — the same subset Vectorize's metadata filter selects).
  const anchoredByKey = new Map<string, number[]>();
  const allIdx: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    allIdx.push(i);
    const r = rows[i];
    if (r?.anchored) {
      const list = anchoredByKey.get(r.key) ?? [];
      list.push(i);
      anchoredByKey.set(r.key, list);
    }
  }

  // Deterministic probe indices.
  const rng = mulberry32(seed);
  const probeIdx = new Set<number>();
  while (probeIdx.size < probeCount) {
    probeIdx.add(Math.floor(rng() * rows.length));
  }

  // surface → K → cell of per-probe overlaps.
  const results: { global: SurfaceResults; filtered: SurfaceResults } = {
    filtered: { 10: emptyCell(), 50: emptyCell() },
    global: { 10: emptyCell(), 50: emptyCell() },
  };
  let filteredProbes = 0;

  let n = 0;
  for (const selfIdx of probeIdx) {
    const probe = rows[selfIdx];
    if (!probe) {
      continue;
    }
    n++;

    // --- global surface ---
    {
      const gt = exactTopK(rows, probe, allIdx, selfIdx, MAX_K);
      const approx = await vectorizeTopK(probe, undefined, false);
      const high = await vectorizeTopK(probe, undefined, true);
      for (const k of K_SET) {
        results.global[k].approx.push(overlapAtK(gt, approx, k));
        results.global[k].high.push(overlapAtK(gt, high, k));
      }
    }

    // --- filtered surface (key:$eq + anchored:$eq true) ---
    {
      const candidateIdx = anchoredByKey.get(probe.key) ?? [];
      // Need enough matches to make the metric meaningful.
      if (candidateIdx.length >= 12) {
        filteredProbes++;
        const filter = { anchored: { $eq: true }, key: { $eq: probe.key } };
        const gt = exactTopK(rows, probe, candidateIdx, selfIdx, MAX_K);
        const approx = await vectorizeTopK(probe, filter, false);
        const high = await vectorizeTopK(probe, filter, true);
        for (const k of K_SET) {
          results.filtered[k].approx.push(overlapAtK(gt, approx, k));
          results.filtered[k].high.push(overlapAtK(gt, high, k));
        }
      }
    }

    if (n % 25 === 0) {
      console.log(`  probes ${n}/${probeCount}`);
    }
  }

  // --- table ---
  const fmt = (xs: number[]): string => (xs.length ? (mean(xs) * 100).toFixed(1) + "%" : "  n/a");
  console.log("\n=== Proof B — overlap@K (Vectorize ANN ∩ exact cosine) ===");
  console.log(`export=${rows.length}  probes=${probeCount}  filteredProbes=${filteredProbes}\n`);
  console.log("surface   mode            overlap@10   overlap@50");
  console.log("--------  --------------  ----------   ----------");
  for (const surface of ["global", "filtered"] as const) {
    for (const [label, key] of [
      ["approximate", "approx"],
      ["high-precision", "high"],
    ] as const) {
      const c10 = results[surface][10][key];
      const c50 = results[surface][50][key];
      console.log(
        `${surface.padEnd(8)}  ${label.padEnd(14)}  ${fmt(c10).padStart(9)}    ${fmt(c50).padStart(9)}`,
      );
    }
  }
  console.log("\nPASS bar (operator-set, target ≥90% for tolerant discovery): compare above.");
}

await main();
