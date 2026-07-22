# Vectorize de-risk spike — runbook

**THROWAWAY. DO NOT MERGE.** This is a self-contained harness to decide ONE thing before we commit to moving Fluncle's vector-similarity discovery off Turso exact `vector_distance_cos` scans and onto **Cloudflare Vectorize** (edge ANN). It proves two things on **real** Vectorize infra (there is no local emulation — Vectorize bindings always talk to a real remote index):

- **Proof A — latency** at 150k-scale: is p95 under 100 ms for the `like` / `sonic` / `neighbours` query shapes?
- **Proof B — recall** vs the exact scan: Vectorize is ANN (documented ~80% raw / >95% refined, **never 100%**). How much recall do we actually lose, per surface shape, in approximate vs high-precision mode? **This is the primary gate.**

Repo canon: never trust local for a scale/quality claim — this runs against real Vectorize. Everything the agent could verify offline (PRNG determinism, cosine, overlap metric, metadata/id-safety, the Worker bundle, the recall client path against a mock exact server) is already green; what remains is **operator-run against live Vectorize**.

Expected spend: **< $3** (see [Cost](#cost)). Nothing here is destructive to any existing Fluncle infra — it creates two throwaway indexes and one throwaway Worker, all torn down at the end.

---

## 0. Prerequisites

- `wrangler` authenticated to the Cloudflare account (`wrangler login` or `CLOUDFLARE_API_TOKEN` with Workers + Vectorize edit).
- Run everything from `spikes/vectorize/`.
- Install deps: `bun install`.

```bash
cd spikes/vectorize
bun install
```

---

## 1. Create the two indexes (1024-dim, cosine)

```bash
wrangler vectorize create fluncle-spike-tracks    --dimensions=1024 --metric=cosine
wrangler vectorize create fluncle-spike-centroids --dimensions=1024 --metric=cosine
```

## 2. Create the metadata indexes — **BEFORE loading any vectors**

A metadata index must exist before vectors are inserted, or pre-existing vectors are not covered. Only the `tracks` index is filtered (the `centroids` `like` probe is unfiltered). Three properties, matching the immutable-only model:

```bash
wrangler vectorize create-metadata-index fluncle-spike-tracks --property-name=key      --type=string
wrangler vectorize create-metadata-index fluncle-spike-tracks --property-name=bpm      --type=number
wrangler vectorize create-metadata-index fluncle-spike-tracks --property-name=anchored --type=boolean
```

> `certified` is deliberately **not** indexed — it is the volatile field the Worker post-filters on (returned, never filtered in Vectorize). Max 10 metadata indexes; filtered strings truncate to 64 bytes; filter JSON must be < 2048 bytes — all well within these.

## 3. Deploy the benchmark Worker

The Worker (`src/worker.ts`) is the gateway the scripts reach the bound indexes through (Vectorize bindings are Worker-only). Both bindings are declared `"remote": true` in `wrangler.jsonc`.

```bash
wrangler deploy
```

Note the deployed URL (e.g. `https://fluncle-spike-vectorize.<subdomain>.workers.dev`) — export it:

```bash
export SPIKE_WORKER_URL="https://fluncle-spike-vectorize.<subdomain>.workers.dev"
```

**Optional auth gate.** To keep the ephemeral Worker from being hit by anyone, set a shared secret; the scripts pass it automatically when `SPIKE_TOKEN` is in the env:

```bash
wrangler secret put SPIKE_TOKEN        # enter a random string
export SPIKE_TOKEN="<the same string>"
```

Sanity check:

```bash
curl "$SPIKE_WORKER_URL/describe?index=tracks"   # → {"index":"tracks","vectorCount":0,...}
```

---

## Proof A — latency (synthetic 150k / 70k corpus)

## 4. Generate the synthetic corpus (deterministic)

```bash
bun run gen:tracks       # 150,000 track vectors  → ./data/tracks.ndjson    (~900 MB)
bun run gen:centroids    # 70,000 centroid vectors → ./data/centroids.ndjson (~420 MB)
```

Random UNIT vectors — valid for latency, NOT for recall (Proof B uses real vectors). Same seed → byte-identical output. Override with `--count N --seed S --out DIR` if needed.

## 5. Load both indexes

`load.ts` streams the NDJSON, upserts in ≤1000-vector batches through the Worker, then polls `/describe` until the count catches up (eventual consistency — "typically a few seconds", no published SLA). Idempotent by id.

```bash
bun run load --index tracks     --worker "$SPIKE_WORKER_URL"
bun run load --index centroids  --worker "$SPIKE_WORKER_URL"
```

Confirm both indexes report their full counts before benchmarking:

```bash
curl "$SPIKE_WORKER_URL/describe?index=tracks"     # vectorCount → 150000
curl "$SPIKE_WORKER_URL/describe?index=centroids"  # vectorCount → 70000
```

## 6. Run the latency benchmarks and collect the table

Each route runs ≥500 timed iterations (fresh deterministic probe per iteration, so Vectorize can't serve an identical-query cache) and reports p50/p95/p99/mean measured around the `env.INDEX.query` call, plus a variant that adds the simulated Worker-side post-filter drop. **PASS = p95 < 100 ms.**

```bash
curl -H "x-spike-token: $SPIKE_TOKEN" "$SPIKE_WORKER_URL/bench/like?iters=500"       | tee out/bench-like.json
curl -H "x-spike-token: $SPIKE_TOKEN" "$SPIKE_WORKER_URL/bench/sonic?iters=500"      | tee out/bench-sonic.json
curl -H "x-spike-token: $SPIKE_TOKEN" "$SPIKE_WORKER_URL/bench/neighbours?iters=500" | tee out/bench-neighbours.json
```

(Drop the `-H` header if you did not set `SPIKE_TOKEN`.) `iters` caps at 900 to stay under the Workers subrequest ceiling.

The three routes:

| Route               | Index     | Shape                                                                                                                                                                                                         |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/bench/like`       | centroids | pre-averaged single probe (avg of 8 anchors), **no filter**, topK 20                                                                                                                                          |
| `/bench/sonic`      | tracks    | single probe, filter `{key:$eq, anchored:$eq true}` — reports **approximate** (topK 60, `returnMetadata:'indexed'`) with no-filter vs filtered timings, AND **high-precision** (`returnValues:true`, topK 50) |
| `/bench/neighbours` | tracks    | global topK≈12 (over-fetch 24 + self-exclusion drop)                                                                                                                                                          |

Each response has `query` (bare) and `withPostFilter` (query + JS drop) summaries and a `pass` boolean.

---

## Proof B — recall vs exact cosine (real embeddings) — the primary gate

Proof B is self-contained: **ground truth = exact brute-force cosine top-K computed locally** over the full export (the export holds every vector, so no DB is needed); **test arm = the same probes queried against a real Vectorize index** loaded with those same vectors; **metric = overlap@K = |exactTopK ∩ vectorizeTopK| / K**, meaned over the probes, per surface × mode.

### 7a. Produce the real-embedding export (read-only, from prod Turso)

One NDJSON row per track that has an embedding. **Read-only** — no writes to prod. Exact format (`RealExportRecord`):

```json
{ "trackId": "string (≤64 bytes)", "embedding": [<1024 floats>], "key": "8A", "bpm": 174, "anchored": true, "certified": false }
```

- `embedding` — the stored MuQ vector, exactly 1024 floats, the same values Turso ranks by. (No need to pre-normalize; the harness computes true cosine.)
- `key` — Camelot string (the field the `sounds like` filter narrows on); `bpm` — integer; `anchored`, `certified` — booleans.
- Include **every** vector you want in the ground-truth universe. The bigger the export, the more faithful the recall number. A full-catalogue export (~150k) is ideal; the harness handles any size.
- Write it to `./data/real-export.ndjson`.

> The exact Turso→NDJSON dump query is an operator step (it reads prod), so it is not scripted here — select `trackId, embedding, key, bpm, anchored, certified` for every row with an embedding and emit one JSON object per line in the shape above.

### 7b. Load the real vectors + run recall

`--load` upserts the export into `fluncle-spike-tracks` first (metadata included), waits for consistency, then runs both surfaces in both modes over `--probes` deterministic probes.

> If `fluncle-spike-tracks` still holds the 150k **synthetic** corpus from Proof A, either recreate it clean (steps 1–2 for `tracks` only) or accept that the synthetic rows dilute the real ground truth. Cleanest: run Proof B on a freshly created `tracks` index.

```bash
mkdir -p out
bun run recall --file ./data/real-export.ndjson --worker "$SPIKE_WORKER_URL" --probes 200 --load | tee out/recall.txt
```

Output is a table of mean overlap@10 / @50 for `global` and `filtered` surfaces × `approximate` and `high-precision` modes.

**PASS bar (operator sets it):** target **≥ 90%** overlap for tolerant discovery ("more like this" / "sounds like"). If approximate falls short but high-precision clears it, the decision is the latency/topK cost of `returnValues:true` (measured in Proof A) — that is the real tradeoff this spike exists to price.

---

## Interpreting the results — known artifacts

- **High-precision caps topK at 50 and cannot over-fetch.** After self-exclusion it compares ≤49 neighbours against the exact top-50, so its overlap@50 tops out near 98% even against a perfect index. Read high-precision @50 as "≈49/50 ceiling"; overlap@10 is unaffected. Approximate over-fetches (topK 51/100) so it has no such ceiling.
- **The post-filter drop in the bench is _simulated_** (a deterministic id-hash drop at the real ~30% `certified` rate), because `certified` is non-indexed and only present under `returnMetadata:'all'` (which would itself cap topK and add latency). It measures the CPU cost of the over-fetch + Worker-side drop, not a real certified distribution.
- **`filtered` recall over a small per-key pool** can read 100% simply because the exact top-K universe is smaller than K — that is honest (the surface genuinely returns everything), just note the pool size (`filteredProbes` in the header).
- The mock-server dry run this harness was validated against returned exactly these artifacts (global approx 100/100, global high-precision 100/98, filtered 100/100), confirming the plumbing before any real spend.

---

## 8. Teardown — **do this when done**

```bash
wrangler delete --name fluncle-spike-vectorize            # the Worker (and its SPIKE_TOKEN secret)
wrangler vectorize delete fluncle-spike-tracks
wrangler vectorize delete fluncle-spike-centroids
rm -rf data out
```

Then delete the branch/PR — nothing here is meant to merge.

---

## Cost

Vectorize bills on **stored vector dimensions** and **queried vector dimensions** (queried = topK × dimensions × queries). Ballpark for this spike:

- Storage: (150k + 70k) × 1024 ≈ **225M stored dims**, held for a few hours.
- Queries: Proof A ≈ 3 routes × 500 iters × (≤2 timing passes) + Proof B ≈ 200 probes × 2 surfaces × 2 modes — order **1e4 queries** × topK≤60 × 1024 ≈ well under a billion queried dims.

Both are inside or a hair over the free monthly allowance (30M stored, 50M queried dims/month on the Workers Free plan; Paid raises the floor and bills pennies per extra million). **Total expected < $3**, dominated by stored-dimension-hours if the indexes are left up — hence the teardown step. Confirm against current Vectorize pricing before running; delete promptly.

---

## Files

| Path              | Purpose                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `wrangler.jsonc`  | Worker config; two `remote:true` Vectorize bindings.                                          |
| `src/worker.ts`   | Benchmark Worker (Proof A `/bench/*`) + gateway (`/admin/load`, `/admin/query`, `/describe`). |
| `worker-env.d.ts` | Ambient binding types (declaration-merged into `Cloudflare.Env`).                             |
| `gen-corpus.ts`   | Deterministic synthetic corpus → NDJSON.                                                      |
| `load.ts`         | Streams NDJSON → ≤1000-vector upserts → consistency wait.                                     |
| `recall-ab.ts`    | Proof B: local exact-cosine ground truth vs Vectorize ANN → overlap@K table.                  |
| `lib/*.ts`        | Pure logic: `prng`, `vector` (cosine/normalize), `metadata`, `overlap`, `stats`, `protocol`.  |
| `tests/*.test.ts` | `bun test` unit tests for all pure logic (no infra).                                          |
