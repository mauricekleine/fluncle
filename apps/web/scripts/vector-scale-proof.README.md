# Vector scale proof — coarse int8 scan + exact float32 rescore

The hosted-scale proof for the two-pass vector primitive (`apps/web/src/lib/server/vector-search.ts`, RFC vector-search-scale slice A). It measures, against **hosted** Turso, whether ranking the compact `embedding_f8` int8 codes and rescoring the top-N against the exact `embedding_blob` float32 vectors stays sub-100ms as the catalogue grows — while preserving top-K recall.

**Why hosted, not `turso dev`.** `AGENTS.md` and `docs/local-database.md` ("Local is not production") are emphatic: the float32 blob-drag cliff, the isolate cap, and the planner traps reproduce **only** on hosted Turso. A vector scan that benchmarks clean locally can be catastrophic in prod. So this harness must run against a real hosted DB, and it is deliberately **not** run in CI or by an agent — the operator runs it against a throwaway scratch DB.

The script touches **nothing** in the app schema: it creates its own `vector_scale_proof` scratch table, seeds it, measures, and drops it. It does **not** create the hosted DB.

## Run it

1. Create a **throwaway** scratch DB (never point this at prod):

   ```sh
   turso db create vector-scale-proof
   turso db show vector-scale-proof --url          # → TURSO_DATABASE_URL
   turso db tokens create vector-scale-proof       # → TURSO_AUTH_TOKEN
   ```

2. Run the harness from `apps/web` (seeds 150k rows, then measures the sonic + recommendations shapes):

   ```sh
   cd apps/web
   TURSO_DATABASE_URL='libsql://vector-scale-proof-<org>.turso.io' \
   TURSO_AUTH_TOKEN='<token>' \
   bun run scripts/vector-scale-proof.ts --rows 150000 --trials 40 --k 12 --probes 12
   ```

   For the synthetic 1M-row projection, raise `--rows` (seeding takes proportionally longer):

   ```sh
   … bun run scripts/vector-scale-proof.ts --rows 1000000 --trials 40 --k 12 --probes 12
   ```

3. Destroy the scratch DB when done:

   ```sh
   turso db destroy vector-scale-proof
   ```

## Flags

| flag       | default  | meaning                                                                |
| ---------- | -------- | ---------------------------------------------------------------------- |
| `--rows`   | `150000` | rows to seed (both columns). Use `1000000` for the 1M projection.      |
| `--trials` | `40`     | query trials per shape (p50/p95 are computed over these).              |
| `--k`      | `12`     | final top-K. The coarse pass over-fetches `k × 8` (COARSE_OVERFETCH).  |
| `--probes` | `12`     | probe count for the recommendations shape (`min`-fold; MAX_REC_SEEDS). |

## What it prints

Per shape (SONIC = 1 probe, RECOMMENDATIONS = `--probes` folded by `min`):

- **OLD (exact f32)** p50/p95 — a single exact float32 scan (today's path).
- **NEW (coarse+resc)** p50/p95 — coarse int8 scan → exact float32 rescore of the top-N.
- **top-K recall (NEW vs exact baseline)** — the overlap of the NEW top-K with the OLD (exact) top-K. Expect ~100% (the rescore is exact; N over-fetches K by 8×).

## Reading the result (the merge gate)

The PR is **HELD** on this: merge only once, at 150k and at 1M, the NEW path is comfortably sub-100ms on p95 **and** top-K recall is ~100% (a couple of ties aside). The primitive keeps `binding probes as raw blobs` and `ranking in SQL` (the ratified rules), so what this measures is purely the ~4× smaller scan payload (`4096 B → 1035 B` per 1024-d row) translating into the expected latency cut.
