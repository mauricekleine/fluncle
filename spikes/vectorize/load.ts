// load.ts — stream an NDJSON corpus into a bound Vectorize index THROUGH the
// spike Worker (Vectorize bindings are Worker-only), in ≤1000-vector batches.
//
//   bun run load.ts --index tracks --worker https://<worker-url> [--file ./data/tracks.ndjson]
//                   [--batch 1000] [--token <secret>] [--no-wait]
//
// Idempotent: upsert-by-id, so re-running resumes safely. After loading it polls
// /describe until the index's vectorCount catches up (eventual consistency —
// "typically a few seconds", no published SLA).

import { parseArgs } from "node:util";

import {
  chunk,
  type CorpusRecord,
  type DescribeResponse,
  type IndexName,
  type LoadResponse,
} from "./lib/protocol";

const { values } = parseArgs({
  options: {
    batch: { type: "string" },
    file: { type: "string" },
    index: { type: "string" },
    "no-wait": { type: "boolean" },
    token: { type: "string" },
    worker: { type: "string" },
  },
});

const index = values.index as IndexName | undefined;
if (index !== "tracks" && index !== "centroids") {
  console.error("--index must be 'tracks' or 'centroids'");
  process.exit(1);
}
const worker = (values.worker ?? process.env.SPIKE_WORKER_URL ?? "").replace(/\/$/, "");
if (!worker) {
  console.error("--worker <url> (or SPIKE_WORKER_URL) is required");
  process.exit(1);
}
const file = values.file ?? `./data/${index}.ndjson`;
const batchSize = Math.min(1000, values.batch ? Number(values.batch) : 1000);
const token = values.token ?? process.env.SPIKE_TOKEN;

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (token) {
    h["x-spike-token"] = token;
  }
  return h;
}

async function postBatch(vectors: CorpusRecord[]): Promise<string> {
  const res = await fetch(`${worker}/admin/load?index=${index}`, {
    body: JSON.stringify({ index, vectors }),
    headers: headers(),
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`load batch failed ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as LoadResponse;
  return body.mutationId;
}

/** Async line iterator over a large NDJSON file (never loads the whole file). */
async function* lines(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let carry = "";
  for await (const bytesChunk of Bun.file(path).stream()) {
    carry += decoder.decode(bytesChunk, { stream: true });
    let nl = carry.indexOf("\n");
    while (nl !== -1) {
      const line = carry.slice(0, nl).trim();
      if (line.length > 0) {
        yield line;
      }
      carry = carry.slice(nl + 1);
      nl = carry.indexOf("\n");
    }
  }
  const tail = carry.trim();
  if (tail.length > 0) {
    yield tail;
  }
}

async function describe(): Promise<DescribeResponse> {
  const res = await fetch(`${worker}/describe?index=${index}`);
  if (!res.ok) {
    throw new Error(`describe failed ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as DescribeResponse;
}

async function waitForConsistency(target: number): Promise<void> {
  const deadline = Date.now() + 20 * 60_000; // 20 min ceiling
  let last = -1;
  while (Date.now() < deadline) {
    await Bun.sleep(5000);
    const info = await describe();
    if (info.vectorCount !== last) {
      console.log(`  index vectorCount=${info.vectorCount} / ${target}`);
      last = info.vectorCount;
    }
    if (info.vectorCount >= target) {
      console.log("consistent.");
      return;
    }
  }
  console.warn(`WARNING: timed out waiting for consistency (last=${last}/${target}).`);
}

async function main(): Promise<void> {
  let buffer: CorpusRecord[] = [];
  let total = 0;
  const mutationIds: string[] = [];

  const flush = async (): Promise<void> => {
    for (const batch of chunk(buffer, batchSize)) {
      mutationIds.push(await postBatch(batch));
      total += batch.length;
      if (total % 10_000 === 0 || batch.length < batchSize) {
        console.log(`  upserted ${total} (${mutationIds.length} batches)`);
      }
    }
    buffer = [];
  };

  console.log(`loading ${file} → ${worker} (index=${index}, batch=${batchSize})`);
  for await (const line of lines(file)) {
    buffer.push(JSON.parse(line) as CorpusRecord);
    if (buffer.length >= batchSize) {
      await flush();
    }
  }
  await flush();

  console.log(`upsert complete: ${total} vectors in ${mutationIds.length} batches.`);
  console.log(`last mutationId: ${mutationIds.at(-1) ?? "(none)"}`);

  if (!values["no-wait"]) {
    console.log("waiting for eventual consistency…");
    await waitForConsistency(total);
  }
}

await main();
