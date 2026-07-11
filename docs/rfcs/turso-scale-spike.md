# Turso at 100k: can libSQL hold the archive and serve the two hot paths?

**Status:** spike complete — measured, not guessed. Every number below came off a run in this repo (`spike/`), against a scratch `turso dev` server and a scratch Turso Cloud database. Nothing touched `fluncle` or `fluncle-dev`.

**The question.** Can Turso/libSQL hold a ~100k-track DnB archive and serve, from a Cloudflare Worker, (1) vector similarity — nearest-neighbour over 1024-d MuQ embeddings, the mix assistant — and (2) full-text search over title/artist/label? The answer gates the D1/D2 alternative on the roadmap.

## Verdict: GO-WITH-CAVEATS

Turso holds 100k tracks comfortably. **Full-text search is an unqualified GO.** **Vector similarity is a GO only in one specific shape**, and the shape we ship today is not it — the current `rankBySimilarity` path breaks well before 100k, and libSQL's native ANN index is unusable on Turso Cloud.

The shape that works, all three parts required:

1. Store the vector as **`F32_BLOB(1024)`** (4,096 B/row), not `embedding_json` (21,675 B/row measured; the real `tracks.embedding_json` in the prod snapshot averages **21,804 B**). 5.6x less storage.
2. Rank **in SQL** — `order by vector_distance_cos(embedding, vector32(?1)) limit 20` — and **bind the probe vector as a raw f32 blob, not a JSON text string**. Text probe at 100k on hosted: **26.7 s**. Blob probe, same query: **1.9 s**. 14x, and invisible in local dev.
3. **Pre-filter to ≲10k candidates before the scan.** The mix assistant filters by key/BPM anyway; the galaxy (cluster) column is the other natural filter. Filtered, one round trip, 100% recall within the filter: **207–274 ms p50** at 100k.

Do **not** use `libsql_vector_idx` / `vector_top_k` on Turso Cloud. It is fast to query and catastrophic to write (below).

If the product later demands _unfiltered, global_ top-k over the full 100k on a public page in <200 ms, that is the NO-GO case and it means a dedicated vector store — see the last section.

## What was tested

|        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local  | `turso dev` (turso CLI v1.0.29 → **sqld 0.24.31**, SQLite 3.45.1), local file, Apple silicon                                                                                                                                                                                                                                                                                                                                                                              |
| Hosted | scratch Turso Cloud db, **server 2026.7.7**, group `default`, `aws-eu-west-1`, queried from NL (≈25 ms RTT is baked into every hosted number)                                                                                                                                                                                                                                                                                                                             |
| Driver | `@libsql/client` 0.17.4, `@libsql/client/web` — **the exact import the Worker uses** (`apps/web/src/lib/server/db.ts`). Every query below went over HTTP, not the CLI.                                                                                                                                                                                                                                                                                                    |
| Corpus | 100k rows: realistic DnB title/artist/label text, plus a 1024-d **L2-normalized** float32 vector per row (MuQ emits unit vectors; the synthetic corpus matches). Vectors stored both ways — `F32_BLOB(1024)` and `embedding_json` TEXT — so the two paths are measured on the same rows. Recall tests use a **clustered** corpus (k=9 centroids + noise), because a genre archive is clustered and uniform-random vectors in 1024-d are a pathological best case for ANN. |

## Seed, size, and build cost

| Thing                                    | Measurement                                         |
| ---------------------------------------- | --------------------------------------------------- |
| Seed 100k rows, local, no index          | 24.5 s (**4,083 rows/s**)                           |
| Seed 100k rows, hosted, no index         | 8.2 min (**204 rows/s**)                            |
| Table with `embedding_json` + blob, 100k | **2,474 MB**                                        |
| Table with blob only, 100k               | **440 MB** ← the JSON column is 82% of the database |
| FTS5 index over title/artist/label, 100k | **~4 MB**; rebuild 0.3 s local / **1.2 s hosted**   |
| DiskANN vector index (`float1bit`), 100k | **1,758 MB** — 4x the vectors it indexes            |
| DiskANN vector index (`float8`), 20k     | 2,070 MB — **103 KB/row**                           |

## Path 1 — the current approach (pull every vector into JS, cosine there)

`getSimilarFindings` (`apps/web/src/lib/server/tracks.ts:831`) selects every `embedding_json` row and ranks in the isolate. The code comment says "instant at the catalogue's scale (dozens → low thousands); `vector_top_k` is the escape hatch past ~10k." **Both halves of that comment are wrong.** It does not reach 10k, and the escape hatch does not exist on Turso Cloud.

Measured, chunked to page around the response cap, on a **local** server (zero network latency — hosted is strictly worse):

| N       | fetch     | parse+cosine | total      | transferred | peak JS heap                                  |
| ------- | --------- | ------------ | ---------- | ----------- | --------------------------------------------- |
| 1,000   | 747 ms    | 32 ms        | **779 ms** | 21 MiB      | 27 MB                                         |
| 5,000   | 3,174 ms  | 152 ms       | **3.3 s**  | 103 MiB     | 29 MB                                         |
| 10,000  | 6,069 ms  | 303 ms       | **6.4 s**  | 207 MiB     | 64 MB                                         |
| 25,000  | 15,319 ms | 772 ms       | **16.1 s** | 517 MiB     | **167 MB** ← past the Worker's 128 MB isolate |
| 50,000  | 31,510 ms | 1,592 ms     | **33.1 s** | 1,034 MiB   | 320 MB                                        |
| 100,000 | 63,111 ms | 3,239 ms     | **66.4 s** | 2,067 MiB   | 689 MB                                        |

The cosine math is not the problem (3.2 s for 100k×1024). **Moving 2 GB of JSON is.**

Two hard walls, both measured:

- **Local dev fails at 460 rows.** `turso dev` (sqld 0.24.31) enforces a **10 MiB response cap**: 459 rows of `embedding_json` = 9.49 MiB is the largest response it will return; row 460 throws `RESPONSE_TOO_LARGE`. The unpaginated `select … where embedding_json is not null` in `getSimilarFindings` therefore **hard-fails in local dev once ~460 findings are embedded** — not a 100k problem, a this-year problem.
- **Hosted has no such cap** (it returned 6,000 rows / **123.6 MiB** — taking 34.6 s), so production will not throw; it will just get slower and then OOM the isolate. The Worker ceiling lands at **N ≈ 10k–20k** on memory, and the path is already past a 1 s budget by ~1,500 rows.

**The brute-force approach is dead. It needs replacing regardless of what we decide about 100k.**

## Path 2 — libSQL native ANN (`libsql_vector_idx` + `vector_top_k`)

The query side is genuinely excellent. At 100k rows, locally, top-20 **plus hydration in a single round trip** (`vector_top_k(...) v join tracks t on t.id = v.id`):

- **7.9 ms p50 / 8.7 ms p95**, 1,940-byte payload.

Then everything else about it fails.

**It cannot be built over existing rows.** On sqld 0.24.31, `CREATE INDEX … libsql_vector_idx(embedding)` on a populated table returns **success and builds an empty index** — the shadow table has 0 rows and `vector_top_k` silently returns nothing. No error, no warning. On hosted 2026.7.7 the same statement over 2,000 rows failed with `vector index: failed to init meta table: database is locked` **and wedged the database's write path**: `DROP TABLE` and `CREATE TABLE` then timed out at 300 s, still wedged 20 minutes later (reads were unaffected). That is a foot-gun aimed at production.

**Index-first is the only working order, and on Turso Cloud the write cost is disqualifying.** Same table, same rows, hosted:

|                                         | insert throughput (hosted)           |
| --------------------------------------- | ------------------------------------ |
| No vector index                         | **217 rows/s**                       |
| Vector index live (`float8`), first row | 6.9 rows/s                           |
| Vector index live, by row 61            | **0.5 rows/s — and still degrading** |

Seeding 100k this way is measured in **days**. Locally (a plain file, no replicated storage) it is merely bad — 89 rows/s with `float1bit` (18.6 min for 100k), 13 rows/s with `float8` (2.1 h), 10 rows/s at defaults (~2.8 h).

**And the only config with a tolerable write cost destroys recall.** Recall@20 against an exact scan:

| Config                          | insert (local) | ANN p50 | recall@20                     |
| ------------------------------- | -------------- | ------- | ----------------------------- |
| default                         | 10 rows/s      | 14.3 ms | 99% _(2k, uniform)_           |
| `compress_neighbors=float8`     | 13 rows/s      | 11.3 ms | **84.6%** _(20k, clustered)_  |
| `compress_neighbors=float1bit`  | 89 rows/s      | 7.9 ms  | **21.6%** _(100k, clustered)_ |
| `float1bit` + `max_neighbors=8` | 841 rows/s     | 2.0 ms  | 59.7% _(2k, uniform)_         |

1-bit compression is what makes the build tractable, and at 100k on clustered data it finds **1 in 5** of the true top-20. A "more like this" row that is 78% wrong is worse than no row.

Add the 1.76 GB index (4x the data it indexes) and the verdict is plain: **native ANN is not an option on Turso Cloud.**

## Path 3 — exact scan in SQL (the one that works)

`select track_id, … , vector_distance_cos(embedding, vector32(?1)) as dist from tracks order by dist limit 20` — no index, one round trip, 100% recall, ~2.5 KB payload.

**The probe binding is the whole ballgame.** At 100k on hosted:

| Probe binding                               | p50                              |
| ------------------------------------------- | -------------------------------- |
| text — `vector32(?)` with a JSON string     | **26,700 ms** (and one HTTP 502) |
| raw f32 blob — `vector32(?)` with the bytes | **1,883 ms**                     |

A 14x cliff that **does not reproduce locally** (sqld returns 175 ms either way), so it will never show up in dev. Page IO is not the cost — a full scan that reads the blob without doing the math (`where length(embedding) > 0`) takes **0.1 s** at 100k. The cost is `vector_distance_cos` re-parsing the 21 KB text probe once per row.

Hosted latency vs N, blob probe, top-20, one round trip:

| N       | p50        | p95      |
| ------- | ---------- | -------- |
| 1,000   | 46 ms      | 174 ms   |
| 5,000   | 89 ms      | 104 ms   |
| 10,000  | **175 ms** | 199 ms   |
| 25,000  | 705 ms     | 887 ms   |
| 50,000  | 1,092 ms   | 1,905 ms |
| 100,000 | 1,883 ms   | 2,035 ms |

Linear, as expected. **Unfiltered global top-k at 100k costs ~2 s** — fine for an operator/admin mix assistant, too slow for a public page.

**Pre-filtering fixes it.** Add a cheap btree filter and scan only the candidates that matter — which is what the mix assistant wants anyway (a track is only mixable if the key and BPM line up):

| Query at 100k (hosted)                                   | candidates | p50        | p95      |
| -------------------------------------------------------- | ---------- | ---------- | -------- |
| `where galaxy = ?` + exact scan                          | 11,111     | **274 ms** | 403 ms   |
| `where camelot = ? and bpm between ? and ?` + exact scan | 8,334      | **207 ms** | 293 ms   |
| no filter                                                | 100,000    | 1,986 ms   | 2,095 ms |

One round trip, 100% recall inside the filter, ~2.5 KB payload. **This is the production shape.**

## Path 4 — FTS5 (unqualified GO)

An FTS5 virtual table over title/artist/label, `content=` external so it stores no duplicate text (~4 MB at 100k; rebuild over 100k = **1.2 s** hosted).

| Query (top-20 + `bm25()` + hydration JOIN, one round trip) | local p50/p95 | **hosted p50/p95** |
| ---------------------------------------------------------- | ------------- | ------------------ |
| token match (`halcyon`)                                    | 7.2 / 9.6 ms  | **114 / 343 ms**   |
| prefix / typeahead (`hal*`)                                | 9.6 / 17.7 ms | **130 / 169 ms**   |
| 2-token AND                                                | 1.4 / 1.7 ms  | —                  |
| column filter (`artist:neur*`)                             | 8.9 / 9.3 ms  | —                  |

Payload ~2 KB. Hosted numbers include ~25 ms of my own RTT; a Worker in the EU sits closer. A public search bar over 100k tracks is a solved problem on Turso.

## Path 5 — the write side (GO)

The enrichment pipeline bulk-inserting while the read path is hot, hosted, on the 100k table (no vector index):

- **348 rows/s** — 2,000 rows in 5.7 s, batches of 250 at 683 ms p50 / 954 ms p95.
- **Zero lock errors.**
- Concurrent reads during the write burst: filtered-NN **355 ms p50** / 1,163 ms p95 (vs 274 ms idle), FTS **110 ms p50**.

Thousands of rows per run is a non-event. (This holds _only_ without the vector index — with it, writes collapse to <1 row/s as shown above.)

## Worker reality check

- **Both hot paths are one round trip.** Top-k + hydration is a single `JOIN`; FTS + hydration is a single `JOIN`. No N+1, no fan-out — one subrequest each, nowhere near the Worker's subrequest budget.
- **Payloads are 2–2.5 KB.** Not a constraint in the working shape.
- **Worker CPU is not the constraint** in the working shape — the database does the distance math and the isolate just deserializes 20 rows. It _is_ the constraint in the current shape: 100k vectors is 689 MB of JS heap against a 128 MB isolate.
- **The response-size wall is the thing to design away from**, and the working shape never approaches it.
- Everything above was measured through `@libsql/client/web` over HTTP, the same code path `getDb()` uses in production.

## Recommendation

**Stay on Turso. Do not spend the D1/D2 spike.** D1 would be a lateral move at best: it has no native vector index either (so the vector path would face the same brute-force problem), it caps at 10 GB/db, and its FTS story is the same SQLite FTS5 we just measured at 114 ms. Turso already does the relational + FTS job well, and it is the system of record.

Concrete follow-ups, in priority order:

1. **Fix `getSimilarFindings` now.** It hard-fails in local dev at ~460 embedded findings and OOMs a Worker somewhere in the low tens of thousands. Replace the pull-everything-into-JS ranking with the in-SQL exact scan.
2. **Add an `embedding_blob F32_BLOB(1024)` column** and stop writing `embedding_json` (5.6x storage; it is 82% of the database at 100k). `vector_extract()` converts existing rows.
3. **Bind the probe as a blob.** The text-probe cliff (26.7 s → 1.9 s) is invisible in dev and lethal in prod.
4. **Pre-filter before the scan** — camelot+BPM for the mix assistant, galaxy for "more like this". Keep candidate sets ≲10k and the path stays under ~300 ms.
5. **Never `CREATE INDEX … libsql_vector_idx` against a populated hosted table.** It wedged the scratch database's write path for 20+ minutes.

**If the shape changes — if we ever need unfiltered global top-k over 100k on a public page in <200 ms — the answer is not D1.** It is a dedicated vector store alongside Turso, most naturally **Cloudflare Vectorize**: 1024-d fits inside its 1536-d limit, 100k vectors is small for a single index, it supports metadata filtering (so the key/BPM pre-filter survives), and it is a native Worker binding — no HTTP round trip, no response cap, and the ANN index is _its_ problem to build rather than a foot-gun that wedges our system of record. Turso would remain the source of truth and Vectorize a derived index rebuilt from it. That is a well-understood two-store design, and this spike says we do not need it yet.

## Reproducing

The throwaway harness lives in `spike/` (not wired into the app, not production code):

```bash
turso dev --port 8911 --db-file /tmp/spike/spike.db     # scratch server, never fluncle-dev
bun spike/turso-scale-spike.ts seed 100000              # seed + size
bun spike/turso-scale-spike.ts vecindex                 # (demonstrates the silent-empty-index trap)
bun spike/turso-scale-spike.ts fts                      # FTS5 build
bun spike/turso-scale-spike.ts bench                    # FTS + exact-scan latency
bun spike/turso-scale-spike.ts bruteforce               # today's path, to the wall
bun spike/vec-index-sweep.ts                            # ANN config sweep (insert/latency/recall)
bun spike/build-indexed-100k.ts                         # index-first 100k build + recall@20
bun spike/cloud-100k-exact.ts                           # hosted: needs SPIKE_CLOUD_URL/_TOKEN of a SCRATCH db
```

The hosted runs used throwaway Turso Cloud databases created and destroyed inside the spike; no scratch database remains.
