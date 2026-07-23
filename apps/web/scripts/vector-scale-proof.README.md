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

2. Run the harness from `apps/web` (seeds 150k rows carrying the `key`/`anchored`/`certified` pre-filter columns, then measures three shapes under their REAL filters):

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

Three shapes, each under the surface's REAL pre-filter:

- **SONIC broad** (1 probe, `anchored = 1`) — a bare "sounds like X" with no key filter, so it scans ~70% of the corpus. This is the HEAVY, realistic case and the decisive one.
- **SONIC narrow** (1 probe, `anchored = 1 and key = ?`) — a keyed "sounds like X" scanning ~3%, showing whether a tighter btree pre-filter rescues the scan when broad is too slow.
- **RECOMMENDATIONS** (`--probes` folded by `min`, `anchored = 1 and certified = 0`) — the per-user engine over ~70% of the corpus.

Per shape:

- **OLD (exact f32)** p50/p95 — a single exact float32 scan (today's path). At 150k the broad scan is expected to blow Turso's query cap — the harness reports `exceeded query cap` rather than crashing; that is the motivation, not a bug.
- **NEW (coarse+resc)** p50/p95 — coarse int8 scan → exact float32 rescore of the top-N. If this _also_ reports `exceeded cap` or is multi-second on the broad shape, that is a real finding (a full SQL scan is slow at scale regardless of vector width) — see the gate below.
- **top-K recall (NEW vs exact baseline)** — overlap of the NEW top-K with the exact top-K, over the trials where the baseline completed (the narrow shape almost always completes, so its recall is the trustworthy quantization number). Expect ~100% (the rescore is exact; N over-fetches K by 8×).

## Reading the result (the merge gate)

The PR is **HELD** on this. Two possible outcomes:

- **GREEN** — the NEW path is comfortably sub-100ms p95 on **SONIC broad** and **RECOMMENDATIONS** (the broad shapes), and recall is ~100%. Then Slice A delivers: merge it.
- **CAPPED/SLOW on broad** — if NEW is multi-second or `exceeded cap` on SONIC broad even though SONIC narrow is fast, that means the int8 coarse scan is still a full SQL scan and the SQL-scan approach has a real ceiling at 150k. Slice A then only helps the _pre-filtered_ (narrow) surfaces, and the in-memory sidecar (RFC Phase 2) matters sooner than the phasing assumed. Report the numbers before merging — do NOT merge a broad-slow result as if it were the win.

Note: seeds are **synthetic random vectors**, so the recall number is directional (random vectors are less clustered than real MuQ embeddings). For a definitive recall verdict, validate against a real-embedding export separately.
