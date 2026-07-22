// SPIKE benchmark Worker — THROWAWAY. Proof A (latency) lives in the /bench/*
// routes; the /admin/* + /describe routes are the gateway the Bun scripts
// (load.ts, recall-ab.ts) use to reach the bound indexes through the binding API
// (Vectorize bindings are only reachable from inside a Worker).
//
// The binding is read via `import { env } from "cloudflare:workers"`, exactly the
// shape the real design uses. Queries pass a RAW VALUES ARRAY (number[1024]) — we
// never use queryById for the anchor, mirroring reading the anchor blob from Turso.

import { env } from "cloudflare:workers";

import { CERTIFIED_P } from "../lib/metadata";
import { type IndexName, type LoadRequest, type QueryRequest } from "../lib/protocol";
import { mulberry32, type Rng } from "../lib/prng";
import { roundSummary, summarize, type Summary } from "../lib/stats";
import { averageUnit, randomUnitVector, toArray } from "../lib/vector";

const PASS_P95_MS = 100;

function indexBinding(name: IndexName): Vectorize {
  return name === "centroids" ? env.SPIKE_CENTROIDS : env.SPIKE_TRACKS;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json" },
    status,
  });
}

/** Optional shared-secret gate. No-op when SPIKE_TOKEN is unset (ephemeral index). */
function authorized(request: Request): boolean {
  const expected = env.SPIKE_TOKEN;
  if (!expected) {
    return true;
  }
  return request.headers.get("x-spike-token") === expected;
}

// A cheap deterministic FNV-1a hash for the simulated post-filter drop.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Simulated Worker-side post-filter: the real design filters immutable fields in
 * Vectorize, then drops rows on a VOLATILE field (`certified`) in the Worker.
 * `certified` is non-indexed, so it is not present unless returnMetadata:'all'
 * (which would cap topK and add latency). To measure the DROP step's cost without
 * forcing 'all', we drop deterministically by id hash at the real ~CERTIFIED_P
 * rate. Returns the surviving ids so the pass is not dead-code-eliminated.
 */
function simulatePostFilter(matches: { id: string }[], wanted: number): string[] {
  const keepThreshold = Math.floor((1 - CERTIFIED_P) * 100);
  const survivors: string[] = [];
  for (const m of matches) {
    if (fnv1a(m.id) % 100 < keepThreshold) {
      survivors.push(m.id);
      if (survivors.length >= wanted) {
        break;
      }
    }
  }
  return survivors;
}

type QueryOpts = {
  topK: number;
  filter?: Record<string, unknown>;
  returnValues?: boolean;
  returnMetadata?: boolean | "all" | "indexed" | "none";
};

/**
 * Run `iters` timed queries against `binding`. `buildProbe(i)` yields a fresh
 * deterministic probe per iteration (so Vectorize can't serve an identical-query
 * cache). Measures purely around the awaited `.query()` call. When `postFilter`
 * is set, a second timing includes the over-fetch + Worker-side drop.
 */
async function benchQueries(
  binding: Vectorize,
  iters: number,
  buildProbe: (rng: Rng, i: number) => number[],
  opts: QueryOpts,
  postFilter: { wanted: number } | null,
): Promise<{ query: Summary; withPostFilter?: Summary }> {
  const bare: number[] = [];
  const withPf: number[] = [];
  for (let i = 0; i < iters; i++) {
    const rng = mulberry32(0x5eed_0000 + i);
    const probe = buildProbe(rng, i);

    const t0 = performance.now();
    const res = await binding.query(probe, {
      topK: opts.topK,
      ...(opts.filter ? { filter: opts.filter as never } : {}),
      ...(opts.returnValues === undefined ? {} : { returnValues: opts.returnValues }),
      ...(opts.returnMetadata === undefined ? {} : { returnMetadata: opts.returnMetadata }),
    });
    const t1 = performance.now();
    bare.push(t1 - t0);

    if (postFilter) {
      const survivors = simulatePostFilter(res.matches, postFilter.wanted);
      const t2 = performance.now();
      // (t2 - t0): query + the JS drop pass, end to end.
      withPf.push(t2 - t0);
      // Touch survivors so the pass isn't elided.
      if (survivors.length < 0) {
        throw new Error("unreachable");
      }
    }
  }
  return {
    query: roundSummary(summarize(bare)),
    ...(postFilter ? { withPostFilter: roundSummary(summarize(withPf)) } : {}),
  };
}

function passed(s: Summary): boolean {
  return s.p95 < PASS_P95_MS;
}

function itersFrom(url: URL): number {
  const raw = Number(url.searchParams.get("iters") ?? "500");
  if (!Number.isFinite(raw) || raw < 1) {
    return 500;
  }
  // Cap to stay under the Workers subrequest ceiling (1000/request on paid).
  return Math.min(900, Math.floor(raw));
}

// ---- Proof A: /bench/like ----------------------------------------------------
// Pre-averaged single probe over SPIKE_CENTROIDS, NO filter.
async function benchLike(url: URL): Promise<Response> {
  const iters = itersFrom(url);
  const K = 8; // anchors averaged into one probe
  const wanted = 12;
  const topK = 20; // over-fetch for the post-filter variant
  const result = await benchQueries(
    indexBinding("centroids"),
    iters,
    (rng) => {
      const anchors: Float32Array[] = [];
      for (let k = 0; k < K; k++) {
        anchors.push(randomUnitVector(rng));
      }
      return toArray(averageUnit(anchors));
    },
    { returnMetadata: "none", topK },
    { wanted },
  );
  return json({
    iters,
    pass: passed(result.query),
    passP95Ms: PASS_P95_MS,
    route: "like",
    surface: "pre-averaged probe over centroids, no filter",
    topK,
    ...result,
  });
}

// ---- Proof A: /bench/sonic ---------------------------------------------------
// Filtered single-probe over SPIKE_TRACKS. Runs BOTH approximate (topK 60,
// returnMetadata 'indexed') and high-precision (returnValues:true, topK 50).
async function benchSonic(url: URL): Promise<Response> {
  const iters = itersFrom(url);
  const wanted = 40;
  // A fixed, representative immutable filter (one Camelot key + anchored). The
  // PROBE varies per iteration (so Vectorize can't serve an identical-query
  // cache); the filter is a constant, which is what an on-the-wire `sounds like`
  // query does — narrow to a key, then rank by vector.
  const sonicFilter: Record<string, unknown> = {
    anchored: { $eq: true },
    key: { $eq: "8A" },
  };
  const probe = (rng: Rng): number[] => toArray(randomUnitVector(rng));

  // Baseline: same shape, NO filter — reported to isolate the filter's cost.
  const approx = await benchQueries(
    indexBinding("tracks"),
    iters,
    probe,
    { filter: undefined, returnMetadata: "indexed", topK: 60 },
    { wanted },
  );
  const approxFiltered = await benchQueries(
    indexBinding("tracks"),
    iters,
    probe,
    { filter: sonicFilter, returnMetadata: "indexed", topK: 60 },
    { wanted },
  );
  const highPrecision = await benchQueries(
    indexBinding("tracks"),
    iters,
    probe,
    { filter: sonicFilter, returnValues: true, topK: 50 },
    { wanted },
  );

  return json({
    approximate: {
      filtered: { ...approxFiltered, pass: passed(approxFiltered.query) },
      noFilter: { ...approx, pass: passed(approx.query) },
      note: "no-filter and filtered timings reported to isolate filter cost",
      returnMetadata: "indexed",
      topK: 60,
    },
    highPrecision: {
      filtered: { ...highPrecision, pass: passed(highPrecision.query) },
      returnValues: true,
      topK: 50,
    },
    iters,
    passP95Ms: PASS_P95_MS,
    route: "sonic",
    surface: "single-probe over tracks, filter {key:$eq, anchored:$eq true}",
  });
}

// ---- Proof A: /bench/neighbours ----------------------------------------------
// Global topK≈12 over SPIKE_TRACKS, self-exclusion via over-fetch + drop.
async function benchNeighbours(url: URL): Promise<Response> {
  const iters = itersFrom(url);
  const wanted = 12;
  const topK = 24; // over-fetch, then drop the self-hit + volatile rows
  const result = await benchQueries(
    indexBinding("tracks"),
    iters,
    (rng) => toArray(randomUnitVector(rng)),
    { returnMetadata: "none", topK },
    { wanted },
  );
  return json({
    iters,
    pass: passed(result.query),
    passP95Ms: PASS_P95_MS,
    route: "neighbours",
    surface: "global topK≈12 over tracks, over-fetch + self-exclusion drop",
    topK,
    ...result,
  });
}

// ---- Gateway: /describe ------------------------------------------------------
async function describe(url: URL): Promise<Response> {
  const name = (url.searchParams.get("index") ?? "tracks") as IndexName;
  const info = await indexBinding(name).describe();
  return json({
    dimensions: info.dimensions,
    index: name,
    processedUpToMutation: info.processedUpToMutation ?? null,
    vectorCount: info.vectorCount,
  });
}

// ---- Gateway: /admin/load ----------------------------------------------------
async function load(request: Request): Promise<Response> {
  const body = (await request.json()) as LoadRequest;
  if (!Array.isArray(body.vectors) || body.vectors.length === 0) {
    return json({ error: "vectors[] required" }, 400);
  }
  if (body.vectors.length > 1000) {
    return json({ error: "batch exceeds the 1000-vector upsert cap" }, 400);
  }
  const mutation = await indexBinding(body.index).upsert(body.vectors);
  return json({ count: body.vectors.length, mutationId: mutation.mutationId });
}

// ---- Gateway: /admin/query ---------------------------------------------------
async function query(request: Request): Promise<Response> {
  const body = (await request.json()) as QueryRequest;
  if (!Array.isArray(body.vector)) {
    return json({ error: "vector number[] required" }, 400);
  }
  const res = await indexBinding(body.index).query(body.vector, {
    topK: body.topK,
    ...(body.filter ? { filter: body.filter as never } : {}),
    ...(body.returnValues === undefined ? {} : { returnValues: body.returnValues }),
    ...(body.returnMetadata === undefined ? {} : { returnMetadata: body.returnMetadata }),
    ...(body.namespace ? { namespace: body.namespace } : {}),
  });
  return json({
    count: res.count,
    matches: res.matches.map((m) => ({
      id: m.id,
      score: m.score,
      ...(m.metadata ? { metadata: m.metadata } : {}),
    })),
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "") {
      return json({
        routes: [
          "GET  /describe?index=tracks|centroids",
          "POST /admin/load?index=tracks|centroids   { vectors: [...] }",
          "POST /admin/query   { index, vector, topK, filter?, returnValues?, returnMetadata? }",
          "GET  /bench/like?iters=500",
          "GET  /bench/sonic?iters=500",
          "GET  /bench/neighbours?iters=500",
        ],
        spike: "fluncle-vectorize",
        warning: "THROWAWAY harness — tear down after the run",
      });
    }

    if (path !== "/describe" && !authorized(request)) {
      return json({ error: "unauthorized (set x-spike-token)" }, 401);
    }

    try {
      switch (path) {
        case "/describe":
          return await describe(url);
        case "/admin/load":
          return await load(request);
        case "/admin/query":
          return await query(request);
        case "/bench/like":
          return await benchLike(url);
        case "/bench/sonic":
          return await benchSonic(url);
        case "/bench/neighbours":
          return await benchNeighbours(url);
        default:
          return json({ error: `no route ${path}` }, 404);
      }
    } catch (err) {
      return json({ error: String(err instanceof Error ? err.message : err) }, 500);
    }
  },
};
