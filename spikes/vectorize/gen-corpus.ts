// gen-corpus.ts — DETERMINISTIC synthetic corpus generator (Proof A only).
//
//   bun run gen-corpus.ts --index tracks     [--count 150000] [--seed 1] [--out ./data]
//   bun run gen-corpus.ts --index centroids  [--count 70000]
//
// Writes upsert-ready NDJSON (one {id, values, metadata?} per line) to
// ./data/<index>.ndjson. Same seed → byte-identical output, on any machine.
//
// Random UNIT vectors are valid for LATENCY (Vectorize scans regardless of
// distribution) but NOT for recall — Proof B (recall-ab.ts) uses REAL vectors.

import { parseArgs } from "node:util";

import { buildTrackMetadata, centroidId, trackId } from "./lib/metadata";
import { mulberry32 } from "./lib/prng";
import { DIMENSIONS, randomUnitVector } from "./lib/vector";

const { values } = parseArgs({
  options: {
    count: { type: "string" },
    dim: { type: "string" },
    index: { type: "string" },
    out: { type: "string" },
    seed: { type: "string" },
  },
});

const index = values.index;
if (index !== "tracks" && index !== "centroids") {
  console.error("--index must be 'tracks' or 'centroids'");
  process.exit(1);
}

const defaultCount = index === "tracks" ? 150_000 : 70_000;
const count = values.count ? Number(values.count) : defaultCount;
const seed = values.seed ? Number(values.seed) : 1;
const dim = values.dim ? Number(values.dim) : DIMENSIONS;
const outDir = values.out ?? "./data";

// Round to 6 d.p. — Vectorize stores float32; full-precision JSON needlessly
// inflates the file 2-3x with no fidelity gain.
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

async function main(): Promise<void> {
  await Bun.$`mkdir -p ${outDir}`.quiet();
  const path = `${outDir}/${index}.ndjson`;
  const sink = Bun.file(path).writer();
  const rng = mulberry32(seed);

  const started = Date.now();
  for (let i = 0; i < count; i++) {
    const vec = randomUnitVector(rng, dim);
    const rounded = Array.from({ length: dim }, (_, d) => round6(vec[d] ?? 0));
    const record =
      index === "tracks"
        ? { id: trackId(i), metadata: buildTrackMetadata(rng), values: rounded }
        : { id: centroidId(i), values: rounded };
    void sink.write(`${JSON.stringify(record)}\n`);

    if ((i + 1) % 10_000 === 0) {
      await sink.flush();
      const rate = Math.round((i + 1) / ((Date.now() - started) / 1000));
      console.log(`  ${index}: ${i + 1}/${count} (${rate}/s)`);
    }
  }
  await sink.end();
  const bytes = (await Bun.file(path).stat()).size;
  console.log(
    `done: ${count} ${index} vectors (dim=${dim}, seed=${seed}) → ${path} (${(bytes / 1e6).toFixed(1)} MB)`,
  );
}

await main();
