# Minimizing Fluncle's data-access latency — research & recommendation

_Research date: 2026-07-16. Method: 6 parallel deep-dives (Turso-native, Cloudflare D1, CF placement/DO, vector search, alternative distributed DBs, DB-agnostic caching) + a codebase current-state recon + an adversarial fact-check of every load-bearing claim against 2026 primary sources. This is a decision brief, not canon — the codebase and the canon docs win on any conflict._

---

## TL;DR — the recommendation

**Do the cheap, reversible, exactness-preserving things first, and earn any database migration with hosted numbers.** Fluncle's latency pain is dominated by **network round-trips and their compounding across sequential SSR queries**, not by vector-scan compute. Two levers attack exactly that, keep the deliberately-engineered exact `vector_distance_cos` scan, and require **zero migration**:

1. **Collapse the compounding** — batch/parallelize the sequential loader queries (a 5-hop SSR page drops from ~920 ms of DB wait to ~184 ms) and extend the existing `/log` edge-cache to every public SSR page (a cache hit pays **zero** Dublin hops).
2. **Pin the SSR compute next to the database** — Cloudflare **Explicit Placement Hints** (`placement.region: "aws:eu-west-1"`) run the Worker adjacent to Turso Dublin, so a distant user pays the ocean crossing **once** (user→Worker) instead of once per query. Config-only, instantly reversible, keeps Turso + libSQL vectors + strong consistency.

Together these fix the SEO/reader half almost completely **and** the per-user uncacheable half (ChatDnB, recommendations, search). Every "replace the database" option (D1+Vectorize, Neon/Postgres, self-hosted, Containers) pays a large migration and either **forks the single store** or **abandons the exact scan** — and none is clearly better than "co-locate compute + cache" until Fluncle proves, with a hosted benchmark, that the residual per-user path is still too slow. **Recommended path: Alternative 1 (phased), below.**

One thing only you can settle tonight-or-tomorrow: **check the Turso dashboard — can this account still add a US/APAC read replica?** That single account fact decides whether a low-effort belt-and-suspenders mitigation even exists (Turso is discontinuing edge replicas for _new_ users).

---

## 1. The problem, grounded in Fluncle's actual numbers

The data layer is a **single Turso primary in Dublin (AWS eu-west-1)**, reached from a **globally-distributed Cloudflare Worker** over stateless HTTP (`@libsql/client/web`), one fresh client per server-function call, **no replica and no read-side batching**. A Worker-vantage probe measures **~184 ms round-trip** to Dublin. Every SSR page pays `184 ms × (its serial-wave depth)` from whatever region the Worker runs in, and **only `/log` is edge-cached**.

Measured per-page shape (from the recon):

| Page                               | DB round-trips | Sequential waves | Cold DB latency                            | Edge-cached?   |
| ---------------------------------- | -------------- | ---------------- | ------------------------------------------ | -------------- |
| `/` home                           | ~7             | ~2               | ~370 ms                                    | ❌             |
| `/log/<id>`                        | ~8             | ~4               | ~896 ms cold TTFB (its own header says so) | ✅ (only this) |
| `/artist/<slug>` (and album/label) | ≥6             | ~4               | ≥740 ms                                    | ❌             |

- **The recurring serial offender** is `getSimilarFindings`' **target → rank → hydrate** triple — three dependent waves on the cold `/log` critical path.
- **`db.batch` (one round-trip for N statements) is used _only_ on write paths.** No read/SSR hot path batches; read fan-out is `Promise.all` (concurrent but still N requests) or plain sequential `await`s.
- **Writes are not the problem:** cron-dominated, ~1 req/s crawler + batched enrichment, far below the proven 348 rows/s hosted ceiling, all funneled through one server boundary. Public reads already tolerate staleness (the `/log` cache serves ≤5-min-stale content). So a "writes-to-primary, reads-from-replica" split is architecturally clean; only the **admin console** and **within-request read-after-write** need the primary.

### The vector layer — the one hard constraint

1024-dim MuQ embeddings live **inside** the Turso store as `F32_BLOB(1024)`, ranked by an **exact `vector_distance_cos` scan** behind a btree pre-filter. This is deliberate and ratified (hosted-measured 2026-07-11):

- Full exact scan at 100k: **1,883 ms** (blob probe) vs **26,700 ms** (text probe — the 14× cliff, invisible locally). With a btree pre-filter (galaxy 11k / camelot+BPM 8.3k): **274 ms / 207 ms**.
- `CREATE INDEX … libsql_vector_idx` on a populated table **wedged the hosted write path for 20+ minutes** (an outage); locally it silently builds an empty index. **No ANN index, by ruling.**
- The vector store feeds three consumers, one of which — **galaxy k-means** — must read the _whole corpus_, not a top-K.
- **The launching-now scale risk:** the per-user **recommendations catalogue scan** (`recommendations.ts`) is an un-pre-filtered ~100k-row exact scan, multiplied by up to **12 `union all` probe branches**, **uncached**, per user.

**Co-location** — vectors + relational rows in one store, one round-trip, ACID, bulk-readable for k-means — is the current design's biggest strength. Every alternative that moves vectors out pays for lower latency with a **second store, a sync pipeline, approximate (ANN) recall, and no bulk-read path**.

---

## 2. The reframe: two independent problems

Almost every option muddles these; keeping them apart is what makes the decision clear.

- **Problem A — network round-trips & compounding.** A distant user crosses the Atlantic **once per query**, and SSR pages issue several sequential queries. This is ~80% of the felt pain and is **cheap to fix** (co-locate compute, batch queries, cache pages) **without touching the database**.
- **Problem B — vector-scan _compute_ at scale.** The exact scan grows linearly; the btree pre-filter keeps it at ~200–274 ms at 100k, but the uncached per-user recommendations scan is the real scale risk. This is a **query-shape / pre-filter / precompute** problem, largely orthogonal to _where_ the database lives, and it is **not** solved by any of the "move the DB" options (they change the engine, not the O(n) scan you chose).

**Insight that drives the recommendation:** the vector query's latency today is dominated by the **184 ms Dublin hop, not scan compute**. So the highest-leverage fix is cutting round-trips and co-locating compute — not swapping the vector engine.

---

## 3. The alternatives

### Alternative 1 — Optimize in place: Placement Hints + batch/parallelize + extend edge-caching ⭐ recommended

Keep Turso. Attack Problem A directly with three composable, no-migration changes:

- **Placement Hints** (`"placement": { "mode": "smart", "region": "aws:eu-west-1" }`) relocate the `fetch` handler next to Turso Dublin. A US/Asia user pays **one** trans-Atlantic hop (user→Worker) instead of one per query; a 5-query SSR page's DB latency goes from ~5×184 ms ≈ **920 ms** to ~5×(2–5 ms intra-region) ≈ **10–25 ms** + the single user hop. Cloudflare's own Sydney→Frankfurt test measured **4–8× faster** end-to-end.
- **Batch/parallelize** the sequential loader queries (`db.batch([...], "read")` / hoist independent reads into `Promise.all`), killing the `getSimilarFindings` triple's compounding.
- **Extend the `/log` edge-cache** pattern (stale-while-revalidate, purge-on-update) to `/`, `/artist`, `/album`, `/label`, `/logbook`, `/galaxies`. A cache hit is a POP-local read — **zero** Dublin hops — which is the single biggest SEO/TTFB lever.

**Latency:** near-elimination of compounding for uncacheable/per-user pages; near-zero for cached public pages. **Vector fit:** fully preserved — exact `vector_distance_cos`, F32_BLOB, k-means all untouched; the heavy scan's _network_ RTT collapses to intra-region. **Consistency:** unchanged (single primary). **Migration cost:** trivial config + an app-side query-shape refactor. **Cons:** Placement Hints is **beta** (docs warn it may change before Smart Placement GA); pinning compute to Dublin makes a distant, _cached_ single-query page's cold render one ocean crossing — but **the caching layer already serves those from the reader's POP**, so the combination is coherent: cache the static reader half at the edge, co-locate compute for the interactive per-user half.

### Alternative 2 — Caching-only baseline (the floor every other option must beat)

Just the caching + batching half of Alt 1, no Placement Hints: edge-cache public SSR HTML + KV read-through for hot reads (edge-local ~5–8 ms vs 184 ms) + batch/parallelize. **Pros:** cheapest on the board, ship-this-week, wins the SEO/reader half almost completely, zero vector risk. **Cons:** does **nothing** for the cold, uncacheable, per-user path — ChatDnB, novel recommendation blends, long-tail "sounds like"/free-text search all still pay the full Dublin hop(s). KV is eventually consistent (≤60 s), so public-read-mostly data only. **Verdict:** necessary but not sufficient — it's the _baseline_, and Alt 1 = this baseline + the one lever that also fixes the per-user path.

### Alternative 3 — Turso multi-region read replicas

Add a US-East (and maybe APAC) read location to the Turso group; the `@libsql/client/web` path is unchanged and auto-routes to the nearest replica. **Pros:** low/no code change, keeps vectors and the exact scan, real win for US/APAC read latency, replicas run the scan locally. **Cons:** Turso is **discontinuing edge replicas for _new_ users** (existing paid accounts keep them "indefinitely") — **so whether this option exists for Fluncle is an account-specific unknown only checkable in the dashboard**; replicas sit in AWS/Fly regions, **not** CF PoPs (closer, never co-located); eventual-consistency lag; per-location cost; and it does **nothing** about sequential-query compounding. **Verdict:** if the account still allows it, a cheap belt-and-suspenders for reads — but don't build long-term on a sunsetting feature.

### Alternative 4 — Cloudflare D1 (global read replicas) + Vectorize

Migrate the relational archive to **D1** (SQLite, native Workers binding, **global read replicas** that route SSR reads to a nearby region) and move vectors to **Vectorize** (managed ANN). **Pros:** the cleanest _native_ global-read story for the relational half — a US/Asia crawler reads a local replica instead of crossing the Atlantic, free, no egress. **Cons (heavy):** D1 read replication is **public beta, not GA**; the **Sessions API refactor** is invasive (without a threaded bookmark, _every_ query hits the primary); **10 GB/DB hard cap**; **FTS5 support on D1 is unverified** (load-bearing for the search token tier); and the killer — **D1 has no `vector_distance_cos`/`F32_BLOB` at all**, so vectors must go to **Vectorize (ANN, not exact; top-K ≤ 50; not bulk-readable → can't feed galaxy k-means)**. This **forks the single store into two synced systems** and **downgrades exact → approximate** — the opposite of the ratified design. **Verdict:** genuinely helps the relational read half, but a large architectural tax and a product-level recall change; only if the team accepts ANN for similarity.

### Alternative 5 — Migrate to Neon (serverless Postgres) + Hyperdrive + pgvector

Full move to Postgres. **pgvector** gives co-located vectors with **exact _or_ HNSW ANN** (a real ANN escape hatch libSQL lacks), bulk-readable for k-means; **Hyperdrive** provides edge connection-pooling + read caching; multi-region **read replicas at no per-replica surcharge**; consumption pricing suits pre-launch. **Cons:** the **highest migration cost** — a full libSQL→Postgres port (dialect drift, **FTS5 → `tsvector`/GIN**, `F32_BLOB` → `vector(1024)` re-encode); Hyperdrive's headline "~9×" is mostly **connection-setup** elimination, not the query hop (uncached cross-region reads still add ~150–200 ms) so global reads still need warm multi-region replicas; scale-to-zero cold starts. **Verdict:** the strongest _replacement_ and the cleanest "real" escape hatch **if exact-scan-at-100k ever becomes untenable** — but it's a data-layer migration justified by scale evidence Fluncle doesn't have yet.

### Alternative 6 — Cloudflare Containers hosting an embedded libSQL replica (de-risking spike)

The option all six silo-briefs missed: **Cloudflare Containers went GA 2026-04-13**, giving a real Linux **filesystem on Cloudflare's own network** — precisely the runtime a libSQL **embedded replica** needs (microsecond local reads, and it **keeps `F32_BLOB` + exact `vector_distance_cos` intact**, unlike D1/Vectorize). **Cons:** container disk is **ephemeral** (a scale-to-zero container wakes with a fresh disk → the replica must re-sync from Dublin on cold start, or persist via snapshots/FUSE-to-R2); containers are **regional, not per-PoP**, so it behaves like a self-hosted regional replica running on CF infra, not a true global edge replica. **Verdict:** the only Cloudflare-native path that preserves the exact scale — worth a **1-day spike** to measure the cold-start re-sync cost, but not a silver bullet and not first-line.

### Also-rans (ruled out, documented so they're not re-litigated)

- **Durable Object SQLite** — GA, real regional read replicas, but **not libSQL**: no `vector_distance_cos`/`F32_BLOB`, so the vector primitive would be hand-rolled brute-force in a single-threaded actor; 10 GB/object; large rebuild. Rule out as a primary.
- **Hyperdrive alone** — **Postgres/MySQL only**, no SQLite/libSQL path. N/A unless you're already migrating to Postgres (Alt 5).
- **Upstash Vector** — regional (its EU region _is_ Dublin's neighbour), so no global win. Skip.
- **Self-hosted libSQL replicas** (rave boxes / VPSes) — **zero dialect/vector/FTS migration** (same engine) and cheapest at the margin, but all replication/backup/monitoring ops become Fluncle's pager, and it only helps a US/Asia reader if you run **public** replicas near CF regions (the rave boxes are tailnet-only/home-region). A fallback if you want to own the stack, not a first move.

---

## 4. Decision matrix

| Option                                             | Fixes global reads   | Fixes compounding            | Keeps exact vector scan | Keeps single store | Migration cost  | Maturity               | Monthly $    |
| -------------------------------------------------- | -------------------- | ---------------------------- | ----------------------- | ------------------ | --------------- | ---------------------- | ------------ |
| **1. Placement + batch + cache** ⭐                | ✅ (co-locate)       | ✅✅                         | ✅                      | ✅                 | **Trivial–low** | Placement **beta**     | ~$0          |
| 2. Caching-only baseline                           | ➖ public only       | ✅ (batch)                   | ✅                      | ✅                 | Low             | GA                     | ~$0          |
| 3. Turso read replicas                             | ✅ if account allows | ❌                           | ✅                      | ✅                 | Very low        | **Sunsetting for new** | per-location |
| 4. D1 + Vectorize                                  | ✅✅ (native)        | ✅                           | ❌ ANN                  | ❌ two stores      | High            | D1-replicas **beta**   | ~$5          |
| 5. Neon + Hyperdrive + pgvector                    | ✅ w/ replicas       | ➖ (Hyperdrive = conn setup) | ✅ (or HNSW)            | ✅                 | **Highest**     | GA                     | usage        |
| 6. Containers + embedded replica                   | ➖ regional          | ✅                           | ✅                      | ✅                 | Med (spike)     | GA, novel use          | container $  |
| DO SQLite / Hyperdrive-alone / Upstash / self-host | —                    | —                            | mostly ❌               | —                  | —               | —                      | —            |

---

## 5. Recommendation & phased roadmap

**Adopt Alternative 1, phased — because the pain is network + compounding, not the engine, and Alt 1 fixes that while preserving the exact co-located vector scan and requiring no migration.** Do it now, while traffic is low, so every measurement is clean and every change is reversible before real users arrive.

**Phase 0 — the free win (ship this week).** Extend the `/log` edge-cache to all public SSR routes (stale-while-revalidate + purge-on-update, the pattern already exists), and **collapse the sequential loader queries** (`db.batch`/`Promise.all`, starting with the `getSimilarFindings` target→rank→hydrate triple). Add a KV read-through for the hottest read-mostly DTOs. This alone takes cached public pages to single-digit-ms globally and cuts uncached SSR from ~4 waves to ~1. Zero risk to vectors.

**Phase 1 — co-locate the compute (this week, behind a flag).** Turn on Placement Hints to `aws:eu-west-1`, and **measure**: the intra-region RTT from a pinned Worker to Turso's endpoint (Cloudflare's "1–3 ms co-located" figure is generic, not a Fluncle-measured Turso number — probe it), and the per-user paths (ChatDnB, recommendations, sonic search). This is the lever that fixes the residue caching can't touch. Reversible in one config line.

**Phase 2 — investigate the cheap replica (parallel, 15 min).** Check the Turso dashboard: **can this account add a US/APAC read location?** If yes and cheap, add one as a reader belt-and-suspenders — but treat it as tactical, since the feature is being sunset.

**Phase 3 — earn the migration (only if the data demands it).** After Phases 0–2, if the cold, uncacheable, per-user global path is _still_ too slow **and** the exact-scan compute at 100k becomes the bottleneck (prove it against **hosted** Turso, per the standing rule), then and only then evaluate the big moves. Ranked: **Neon + pgvector** (cleanest "real" store with a genuine ANN escape hatch) > a **Containers embedded-replica spike** (keeps libSQL exact scan on CF infra) > **D1 + Vectorize** (best native relational reads, but forks the store and goes ANN). Address Problem B's specific risk — the per-user recommendations catalogue scan — first with a **btree pre-filter or a precomputed candidate table** (the `rank_catalogue` pattern already in the codebase), independent of any DB move.

**Why not jump straight to D1/Neon?** Because both pay a large migration to buy a read-latency win that Placement Hints delivers for a config line **without abandoning the exact scan Fluncle deliberately engineered** — and D1 additionally forks the store and downgrades similarity to ANN. The disciplined move is: do the reversible, exactness-preserving, no-migration thing first; let real post-launch numbers, not speculation, decide whether a migration is ever warranted.

---

## 6. Open questions to close before/while acting

1. **Turso account:** can it still add read-replica locations? (dashboard — decides Alt 3.)
2. **Placement RTT probe:** actual CF-colo→Turso-eu-west-1 intra-region latency once pinned (validates Phase 1's magnitude).
3. **FTS5 on D1:** does D1's SQLite build ship FTS5 virtual tables? (blocks Alt 4 if not.)
4. **Hosted vector benchmark:** the per-user recommendations catalogue scan (≤12 `union all`, uncached) at 100k against hosted Turso — is it acceptable, or does it need a pre-filter/precompute now? (Problem B, independent of any migration.)
5. Vectorize/Upstash real p50/p99 — no vendor number exists; would need a spike to measure if Alt 4 is seriously considered.

---

## Appendix — fact-check status (2026 primary sources)

All load-bearing status claims were verified and **hold in 2026**: D1 read replication is **public beta** (not GA); Explicit Placement Hints are **real but beta** (2026-01-22, `placement.region` accepts AWS regions, 4–8× measured, `fetch`-handlers only); Vectorize is **GA** (1024-dim ✓, cosine ✓, ANN-not-exact, top-K ≤ 50 w/ metadata, not bulk-readable); embedded replicas **need a filesystem** (so cannot run in a Worker isolate — but Cloudflare **Containers** now provide one); Turso is **discontinuing edge replicas for new users**; Hyperdrive is **Postgres/MySQL-only**; the Turso Rust rewrite is **beta** with DiskANN still an open backlog issue. The two things the silo-briefs missed and the fact-check surfaced: **Cloudflare Containers as a filesystem-on-CF** (Alt 6) and **the assembled combination** (Alt 1) that no single brief named as the answer.

Primary sources are cited inline in the per-dimension briefs (retained in the research transcript). Key ones: Cloudflare Workers Placement docs + the 2026-01-22 changelog; D1 read-replication docs + release notes; Vectorize limits/pricing; Turso platform-roadmap blog (edge-replica discontinuation) + embedded-replicas docs; Neon read-replicas + Hyperdrive-Neon FAQ; Cloudflare Containers GA changelog (2026-04-13); and Fluncle's own `docs/local-database.md` "Local is not production" measurements.
