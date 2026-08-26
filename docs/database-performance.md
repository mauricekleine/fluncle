# Database performance contract

This document is the canonical, public contract for measuring Fluncle's database work. The Turso scalability program integrates from commit `f0b368203d42a3b92d5b5025c8064e27baa9f632` on the non-production `program/turso-scale` branch. Program work targets that branch only; the branch is implementation state, is never a production deployment source, and does not authorize a deploy, production query, hosted database creation, paid action, credential use, timer change, or mutation.

The harness lives in [`apps/web/scripts/db-performance`](../apps/web/scripts/db-performance). It owns one manifest, one synthetic fixture stream, one extensible contract registry, one runner, and one explicit budget vocabulary. It changes no production table, query, index, projection, or mutation path. The checked-in `perf_*` schema exists only inside a scratch or in-memory harness database.

## Evidence manifest

[`manifest.json`](../apps/web/scripts/db-performance/manifest.json) is the machine-readable audited 1× baseline. Scaling is deterministic integer multiplication: every audited cardinality and backlog is multiplied by exactly two or four. The 4× profile is a warning curve rather than a promise that every product SLO already holds.

| Signal                      |      1× |      2× |      4× |
| --------------------------- | ------: | ------: | ------: |
| tracks                      | 122,151 | 244,302 | 488,604 |
| track embeddings            |  43,372 |  86,744 | 173,488 |
| track-artist edges          | 154,551 | 309,102 | 618,204 |
| findings                    |      96 |     192 |     384 |
| artists                     |  13,543 |  27,086 |  54,172 |
| labels                      |   6,401 |  12,802 |  25,604 |
| albums                      |  27,454 |  54,908 | 109,816 |
| crawl frontier              | 211,980 | 423,960 | 847,920 |
| pending frontier            | 130,864 | 261,728 | 523,456 |
| enabled-label tracks        | 117,710 | 235,420 | 470,840 |
| YouTube-provenance backlog  |  30,260 |  60,520 | 121,040 |
| MusicBrainz-to-ISRC backlog |  44,473 |  88,946 | 177,892 |
| full-analysis backlog       |       0 |       0 |       0 |

Only row and backlog cardinalities in the table above multiply. Audited inventory metadata remains a fixed 1× reference: 945 MB database size, 78 production tables including virtual/shadow tables, 147 production indexes, 31 indexes on `tracks`, and no `sqlite_stat1` or `sqlite_stat4`. These values are not projected to 2×/4× because schema-object counts and storage bytes do not scale as row arithmetic.

The generator preserves the distributions that make the known shapes meaningful: 96 of 122,151 tracks are findings-backed; 43,372 have an embedding and 78,779 have a null/missing embedding; 154,551 artist edges give a mean fan-out of approximately 1.2652, modeled as one edge for every track and an exact 32,400-row second edge slice; 117,710 tracks, or approximately 96.4%, sit under enabled labels; 130,864 of 211,980 frontier rows are pending; the two measured non-empty work backlogs contain exactly 30,260 and 44,473 rows; and the measured empty full-analysis queue remains empty. Findings, embeddings, edge positions, label scope, frontier state, nulls, and backlog flags are spread deterministically rather than randomly. The audited vector reference is 43,372 embeddings × 1,024 float32 values × 4 bytes = 177,651,712 raw bytes, approximately 178 MB decimal, before table/index overhead.

Every value is derived from a row index and uses a `synthetic-*` ID or name. The generator has no production-data input, URL, credential reader, or network path. It yields at most 500 statements by default and reuses one deterministic 4,096-byte embedding blob, so a 4× run does not allocate all rows or vectors in memory. A small ratio-preserving derivative is available for CI, but its report says `exactProfileCardinality: false`; it is never presented as 1× evidence.

## Budgets

The registry encodes budgets as assertions and reports p50, p95, p99, maximum, result-row counts, affected-row counts, batch counts, queueing, plan output, and pass/fail. Current and 2× are required where specified. A red required budget is a failure; an average cannot waive it. A 4× timing miss is reported as a warning unless the invariant is explicitly required at 4×, but correctness, bounded memory, and plan laws still fail at every profile.

| Work class                         | Required steady-state contract                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| Public route database spans        | p95 ≤ 250 ms and p99 ≤ 750 ms at 1× and 2×                                                   |
| Public route end-to-end            | p95 ≤ 1 s and p99 ≤ 2.5 s at 1× and 2×                                                       |
| Queue empty check or bounded claim | p95 ≤ 250 ms at 2×                                                                           |
| Background writer admission        | p95 ≤ 250 ms when uncontended at 2×; contention must be bounded and observable               |
| Ordinary mutation transaction      | no successful ordinary write above 2 s at 2×                                                 |
| Ambiguous mutation                 | every timeout resolves to committed, rejected, or safely retryable; zero unresolved outcomes |
| Sonar steady-state refresh         | zero remote full-corpus scans at 1×, 2×, and 4×                                              |
| Device derivation                  | zero repeated production-corpus scans beyond replica synchronization at 1×, 2×, and 4×       |

## Query-plan laws

A request-time or per-tick query must not scan a growing corpus merely to prove an empty queue, compute a count, or select a bounded batch. A bounded claim starts from an index whose leading columns express eligibility, due time, and ordering, or from a maintained work projection whose cardinality follows the backlog. Separate identity keys use separate sargable branches; a `CASE` or `OR` join that defeats every candidate index is forbidden on growing tables. A tiny selective relation such as `findings` must be able to drive its join because hosted Turso provides no production `ANALYZE` statistics for this workload. Request-time window sampling, expression grouping over a full catalogue, and repeated `UNION`/`GROUP BY` reconstruction belong in maintained projections or aggregates rather than hot reads.

Every critical contract asserts output correctness and plan shape. The runner records every `EXPLAIN QUERY PLAN` detail and detects a growing-table `SCAN` and `USE TEMP B-TREE`; contracts name the growing tables, allowed exceptional scans, required index/driver details, and whether temporary sorting is forbidden. Timing is evidence, never the only regression oracle.

Schema-neutral rewrite contracts execute both the reference and optimized statements over the same deterministic fixture, record both ordered outputs and row counts, measure only the optimized statement, and retain the reference plan in report metadata. Reference output and plan evidence are read once per fixture client rather than repeating a known-dangerous scan for every timing iteration. The artist-link fixture includes claimed and unclaimed MBIDs, same-name collisions, name drift, null identity, duplicate credits, catalogue flags, and position ordering; its optimized plan must probe the track primary key plus the MBID and NOCASE-name artist indexes without a growing-table scan or temporary sort. Sitemap finding rows, counts, and entity lastmods must drive from `perf_findings`, probe outward by indexed keys, and preserve the reference count, null, lastmod, and ordered-row results. The shared single-row optional-finding, single-row required-finding, plural identity-reference, and bounded bulk track/Log-ID resolver families each retain their reference output while probing both the track primary key and unique Log-ID index; no consumer may restore the cross-table `OR` shape.

## Mutation laws

Background write work ultimately uses one global admission path with lease expiry, ownership, heartbeat, queue age, and contention telemetry. At most one background writer and one explicitly classified heavy reader may run concurrently once that later program goal lands. Public requests do not wait behind newly admitted best-effort sweeps: background work yields, chunks transactions, and stops renewing while health or public latency is outside its guardrail.

Every externally retryable or timeout-prone logical mutation selected for receipt coverage carries an operation key and writes its receipt atomically with its effect. An unknown response is reconciled before replay. Projections define a source of truth, transactional maintenance where practical, an idempotent rebuild, and a drift audit. Backfills are resumable, chunked, observable, and reversible until verified; schema expansion, shadow/backfill, cutover, and contraction remain separate phases. Goal A records these laws and instrumentation but does not implement receipts, projections, admission, or SQL changes.

### Retry disposition and atomic receipts

[`database-operation-registry.ts`](../apps/web/src/lib/server/database-operation-registry.ts) is the executable retry-policy inventory for every recurring timer/CLI database operation and every incident mutation it names. A write is exactly one of `receipt-backed`, `replay-safe-idempotent`, or `deliberately-non-replayable`; reads and no-database work are `not-applicable`. Each disposition carries a checked-in mechanical source plus its proof or bounded reconciliation rule, and the completeness test fails when a write or incident lacks one. A replay-safe label does not authorize the generic database retry wrapper to retry writes: the owning caller must still use the registered stable-state proof. A deliberately non-replayable path must inspect its bounded queue item, artifact identity, or external publication state instead of blindly repeating the action.

`health.snapshot` is the sole receipt-backed operation. Its caller derives `health.snapshot:<at>` from the snapshot timestamp, and the Worker computes a SHA-256 digest over canonical JSON with sorted object keys and stable array order. `operation_receipts.operation_key` is the unique logical identity. An `accepted` row has no result; a terminal `committed` or `rejected` row has a bounded stable `result_identity`, canonical `result_json`, and terminal timestamp. The snapshot's status rows, transition events, check samples, pruning, and terminal receipt share one libSQL write transaction. A rollback therefore leaves neither effect nor a false terminal receipt.

Same-key/same-digest replay returns the stored terminal result without running the effect. Same-key/different-digest is a conflict. An accepted receipt is in progress. Any transaction or transport failure performs a receipt lookup before the caller may decide what to do: terminal returns the original result, absence is safely retryable, accepted remains in progress, and lookup failure is unresolved and never authorizes replay. Duplicate callers converge through the operation-key primary key and the same reconciliation path.

The `health_snapshot_receipts_enabled` setting is default-off and opens only for the exact value `true`; missing, malformed, or unreadable values keep the legacy writer. The caller can carry the deterministic operation key before the flag opens, so schema expansion, initialization/shadow, and caller cutover remain independently deployable. The legacy path remains the rollback path until contraction.

Read-only reconciliation is available through `fluncle admin receipts get <operation-key> [--json]`. It returns bounded state, operation ID, stable result identity, and timestamps, never the request digest or stored result payload. `fluncle admin receipts repair --stale-before <ISO> [--limit 50] [--json]` is the explicit operator-only repair: it rejects at most 100 accepted rows strictly older than the supplied fence. Reconciliation and repair emit low-cardinality spans and structured evidence containing the operation ID, outcome, and aggregate counts only; operation keys, digests, request/result bodies, secrets, URLs, and topology never enter Sentry or logs.

### Due-work projection

Recurring track and graph-entity selectors materialize eligibility in `due_work`. One physical `work_kind` owns each eligibility and priority policy, while `subject_type` and `subject_id` identify the source row. `ready` rows are claimed through the ready-order index; future retry windows remain `scheduled` until a bounded promotion; leased rows carry an owner, token, and expiry; and `repair` rows are transactionally coupled proof that a source mutation still needs projection repair. An absent or terminal source has no projected row.

The source tables remain authoritative. Each registered definition provides a primary-key-ordered bounded reader, a pure evaluator, and an explicit source-version token. Rebuild checkpoints make zero-row, interrupted, and completed runs idempotent. A new generation upserts the rows it observes and deletes only older-generation rows after the source walk completes, while concurrent repair markers survive that contraction. Drift comparison reads bounded source and projection pages and reports missing, unexpected, and field-mismatched rows without mutating either side.

The local backfill command is `bun run --cwd apps/web db:backfill-due-work`; it rejects every non-local database URL before opening a client. Backfill and shadow comparison populate and verify the projection without changing selector behavior. The completed rebuild also caches the catalogue-rank fingerprint and finding counts, so a projected empty rank tick can preserve its response contract through one KV probe without recomputing the live corpus. The `track_work_due_cutover_enabled` setting opens runtime reads only for the exact value `true`; missing, malformed, and failed setting reads stay on the legacy path. With the flag open, every recurring consumer repairs a bounded marker page, promotes elapsed retries, and reads the maintained ready-order index without falling back to a source-table scan or second count. The legacy selectors remain the rollback path until Goal H contracts them.

Eligibility-changing writers append a subject repair marker in the same libSQL write transaction as their source mutation. A bounded consumer pass expands that marker into the registered physical queue markers without evaluating the source repeatedly, then repairs only the queue being read from the authoritative source row. The checked-in producer inventory parses every mutation site across the base and satellite eligibility tables, proves that the marker shares that site's write batch or explicit transaction, and follows statement builders through every callsite to a coupled producer. Exact SQL-fingerprinted dispositions cover serialization, fixtures, and fields no evaluator consumes, so another mutation in an already-reviewed file still fails closed. Rebuild and drift audit remain the independent convergence proof.

### Crawl and public shadow projections

The crawler's separate `crawl_due_work` projection preserves its two-lane law: up to `ceil(limit / 2)` release slots use the storable-first release index, then the general breadth-first index fills the rest. Pending nodes are ready, retryable failures are scheduled at their failure-scaled due time, and every drained allowed MusicBrainz artist becomes a daily tail subscription once its allow has no unstamped rearm request. Claims carry an owner, token, ordered position, and expiry; promotion, lease reaping, direct node repair, and label/artist-rule fanout are bounded by the projection's partial and fanout indexes. The source frontier remains authoritative. The `crawl_due_cutover_enabled` setting is default-off and opens only for the exact value `true`; missing, false, malformed, and failed reads retain the unchanged legacy selector. An open pass runs forward seed/rule maintenance first, drains only bounded repair pages, promotes retries independently and tail-rearms at most the oldest ten due stale artists, claims the maintained two-lane order with one pass owner/token and a lease longer than the bounded HTTP pass, and hydrates only the claimed frontier primary keys in `claim_position` order. Stale-artist promotion atomically moves the authoritative row and its due row and preserves the pass counter even when the caller claims zero nodes, so the open path never executes the legacy double artist-rule probe or its sort. Success or failure settlement transactionally verifies the node/token lease, mutates the authoritative frontier row, deletes only that lease, and appends the exact repair marker; a stale token changes nothing and contributes no pass counters.

The public shadow projections materialize only the stable global facts: total tracks; exact non-NULL literal `substr(release_date, 1, 4)` and key buckets; the invalidation epoch for the default `release_date DESC, track_id DESC` hub order; and artist qualification. Qualification counts one certified finding per credited artist and enabled-label credits as two half-units for a primary artist or one for a remixer, with membership at any certified finding or six half-units. Per-track memberships and per-track/artist contributions retain the old side of every delta, label rulings fan out through `tracks_label_id_idx`, and repair epochs prevent a newer source marker from being consumed by an older repair.

The shadow maintenance contract is transactional dual-write through audited source chokepoints. A real track subject changed through a `tracks`, `findings`, or `track_artists` writer appends both aggregate and artist-qualification repair markers with one source version and timestamp; label and direct artist subjects append qualification markers, while the synthetic catalogue-rank corpus subject never enters a public projection. Every `crawl_frontier` mutation in the crawler appends the exact node repair in the same bounded write batch, and label seed/scope plus artist-rule verdict/rearm writes append indexed label-slug or artist-MBID fanout markers in their source transaction. A guarded source no-op appends no work, fanout and repair are bounded and race-token guarded, and the source tables remain authoritative throughout shadow operation.

Both projection families rebuild by stable sorted IDs with durable generation checkpoints, preserve live repairs newer than the rebuild start, compute exact source/projection digests, schedule only bounded drift repairs, and expose legacy shadow comparators. Default hub anchors are rebuilt deterministically outside request time and are published with their order epoch and format version. A complete anchor document makes each numbered default page an exact strict `(release_date, track_id)` suffix over `tracks_release_date_track_id_idx`; the one non-NULL-to-NULL transition is split into two bounded range reads, so neither ties nor NULL ordering can force a corpus walk or temporary sort. Arbitrary filtered public queries deliberately remain indexed source queries rather than a combinatorial aggregate cube. The `public_projection_cutover_enabled` setting is default-off and opens only for the exact value `true`; every other value or settings read failure retains the exact legacy query. Aggregate reads are usable only when the `tracks` state is `complete`, `aggregate_epoch = source_epoch`, and no `public_aggregates` repair exists. Artist qualification is independently usable only when its `artists` state is `complete`, `projection_epoch = source_epoch`, and no `artist_qualification` repair exists. Default release-hub anchors additionally require the exact hub/clause address, the current anchor format, a non-empty generation matching aggregate state, `order_epoch = release_hub_order_epoch`, a complete page-boundary document for the projected total, and defensively valid JSON. Usable projections serve the default total, literal release-year and key buckets, qualified artist IDs, and default-hub anchors; filtered hub reads and every unusable/error case keep the legacy source query. Public requests only probe readiness and read projections: rebuild, audit, and repair remain operator/backfill work.

The local command is `bun run --cwd apps/web db:backfill-shadow-projections`; it resumes existing generations by default, accepts `--new-generation`, `--audit-only`, `--limit`, and `--repair-limit`, and refuses hosted or non-loopback database URLs before opening a client.

## Test-data laws

Raw production data and identifiers never enter the repository or CI artifacts. Fixtures are deterministic and synthetic while preserving audited cardinality, selectivity, null distribution, fan-out, and backlog distribution. Exact 1×, 2×, and 4× profiles derive only from the checked-in manifest. Local SQLite/libSQL is mandatory for correctness and deterministic plan tests. Hosted Turso is a separate scratch-only replay because local behavior is not hosted performance evidence.

Mutation contracts must operate only on a disposable harness database, use stable synthetic keys, and be idempotent or reset their fixture between samples. A timing contract must warm up explicitly, use deterministic iteration counts, report every distribution, and retain result/affected-row counts so a fast empty or wrong query cannot pass. A plan assertion must name every growing table and narrowly justify any allowed scan. Fixture changes update the manifest contract and determinism/selectivity tests in the same change.

## Local and hosted are different

Local libSQL is the correctness oracle, not a hosted-performance substitute. Four known divergences are mandatory interpretation context:

1. A query vector bound as text has a hosted probe-binding cliff that local `sqld` does not show. At 100,000 rows the observed hosted p50 was 26,700 ms for text versus 1,883 ms for a raw BLOB, while both were 175 ms locally. Bind vectors as raw BLOBs.
2. Do not build `libsql_vector_idx` on a populated table. Hosted creation can block writes while local creation can yield an empty index. Use an exact `vector_distance_cos` scan behind a B-tree prefilter.
3. The response cap fails loudly above 10 MiB in local development, while hosted queries can continue until they exhaust the Worker's 128 MB isolate. Rank growing vector columns in SQL instead of returning them for application-side ranking.
4. A flattened CTE fanned out by `UNION ALL` branches or outer cross-join rows is re-executed per branch or row. Fold multi-probe distances into one select expression; materialize bounded pair scans and pin the small findings relation as the driver.

Any query scanning a table that grows with the archive needs an attended hosted scratch replay before anyone claims that it scales. That replay confirms planner and network behavior; it never targets production or development databases.

## Client bounds and mixed-load evidence

`@libsql/client`'s remote HTTP default is 20 operations per client, and `concurrency: 0` also resolves to 20. Local `:memory:` and `file:` clients ignore that option. The explicit numbers below bound one client instance; they do not limit aggregate Workers, requests, isolates, processes, timers, or fleet units.

| Client class                         | Bound | Rationale                                                                                                                                                                                                                                         |
| ------------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary Worker client                |     4 | Preserves ordinary route fan-out while preventing one logical caller from issuing 20 remote operations. Known request fan-outs include three, five, and seven reads; four is the explicit compromise to test rather than a global capacity claim. |
| Fleet telemetry client               |     3 | The ledger reader intentionally performs page, rollup, and count concurrently; inserts remain a single statement.                                                                                                                                 |
| Catalogue public-entity count script |     3 | Its only deliberate direct-client fan-out is three concurrent counts.                                                                                                                                                                             |
| Maintenance/operator scripts         |     1 | One-shot migration, backfill, inspection, and destructive tooling is sequential or explicitly batched.                                                                                                                                            |
| Hosted benchmarks                    |     1 | Measurement must not accidentally manufacture same-client parallel load.                                                                                                                                                                          |
| Seed clients                         |     1 | Fixture and seed writes are ordered, chunked batches.                                                                                                                                                                                             |
| Readiness and smoke clients          |     1 | Readiness, migration, and smoke steps are serial.                                                                                                                                                                                                 |
| Local HTTP helpers                   |     1 | Local server setup and browser fixture paths are serial even though a local engine may ignore the transport option.                                                                                                                               |
| File clients                         |     1 | Restore, derivation, and other file-backed paths are serial; this records intent where the local driver ignores the option.                                                                                                                       |
| Test clients                         |     1 | Tests declare their expected shape and use a separate controlled scheduler for concurrency evidence.                                                                                                                                              |

The deterministic mixed-load contract starts one held 100 ms heavy reader, three 5 ms public reads, and two serialized write batches on the primary four-slot model. It records per-class queue and latency p50/p95/p99 plus observed maximum concurrency. The public reads start while the heavy reader is held, and write batches do not overlap. Replacing the primary bound with one makes the test report the avoidable public convoy; replacing it with the library default of 20 makes the explicit-bound check fail.

This is per-client evidence only. The simulator's write lane models SQLite transaction serialization inside the scenario and deliberately does not implement cross-unit admission, fleet fairness, writer leases, or a global heavy-reader limit. Those are later program remediation, and a green Goal A mixed-load contract must never be described as proving them.

## Telemetry and privacy vocabulary

Database query spans and fleet run records share a bounded vocabulary: `operation_id`, `access_class`, `release`, `attempt_count`, nullable `batch_count`, `duration_ms`, and `outcome`. Operation IDs are stable, validated, low-cardinality identifiers with a deterministic sanitized fallback. Access class is exactly `read`, `write`, or `heavy-read`. Release identifies committed code, attempts count actual attempts, batch count is null when unknowable, duration is measured elapsed time, and outcome is exactly `success` or `failure`.

SQL arguments, interpolated literals, raw rows, names, email addresses, track or user identifiers, secret values, tokens, hostnames, URLs, ports, and private topology never enter that vocabulary. `db.query` remains the Sentry operation, and `sendDefaultPii: false` remains mandatory. Query descriptions are normalized grouping labels rather than raw SQL when literals could leak. The runner's JSON contains plan text and aggregate counts only for registered synthetic or reviewed statements; a new contract must audit its statement and metadata before registration.

## Run and interpret the harness

Run the lightweight local suite, which materializes only a 512-track derivative:

```bash
bun run --cwd apps/web db:performance --profile 1x
bun run --cwd apps/web db:performance --profile 2x
bun run --cwd apps/web db:performance --profile 4x
```

Select or list contracts independently:

```bash
bun run --cwd apps/web db:performance --list
bun run --cwd apps/web db:performance --profile 2x --contract fixture.frontier-pending-claim
```

An exact local profile is explicit because it may write millions of rows while remaining memory-bounded:

```bash
bun run --cwd apps/web db:performance --profile 1x --full-fixture
```

The command writes one JSON document. `report.passed` is false for any required budget, correctness, or plan-law failure. At 4×, timing misses appear under `budget.warnings`; correctness and plan violations remain failures. Inspect `durationMs`, `queueMs`, `resultRowCount`, plan `details`, `fullScans`, `tempSorts`, validation failures, and the fixture's `exactProfileCardinality` before comparing runs.

## Add a contract

Register a stable lowercase ID in [`contracts.ts`](../apps/web/scripts/db-performance/contracts.ts), choose the matching work class, set deterministic warm-up and measured iteration counts, and provide either a SQL statement through `sqlContract` or one custom observation callback. A SQL contract adds its `EXPLAIN QUERY PLAN` statement and names growing tables, forbidden temporary sorting, required driver/index details, and any narrowly allowed scan. Its correctness hook asserts ordered values or a stable digest where needed and always asserts result cardinality. Add a focused test that demonstrates the intended result and that the old or malformed plan fails.

If the contract needs new fixture state, extend the one manifest/generator rather than adding a bespoke seed script. Preserve stable synthetic identifiers, exact distributions, chunking, and the 1×/2×/4× multiplication law. Do not add a production index, rewrite product SQL, or copy a row from any live database as part of a harness change.

## Operator-gated hosted replay

Hosted replay is inert unless `--hosted` and `--operator-approved` are both present. Only after both gates does the runner read `FLUNCLE_DB_PERF_SCRATCH_URL` and `FLUNCLE_DB_PERF_SCRATCH_TOKEN`. It rejects missing values, local/file URLs, embedded credentials, and targets whose identifiers look like production, development, local, or the live product. It creates no database or infrastructure; the operator must supply a disposable scratch database. After the gates pass, each run drops only the fixed harness-owned `perf_*` allowlist before recreating it, so a prior 4× replay cannot contaminate a later 1× result and unrelated tables remain untouched. Hosted replay materializes the exact selected profile and uses direct-client concurrency one.

```bash
FLUNCLE_DB_PERF_SCRATCH_URL='libsql://<scratch-database>' \
FLUNCLE_DB_PERF_SCRATCH_TOKEN='<scratch-token>' \
bun run --cwd apps/web db:performance --profile 1x --hosted --operator-approved
```

The presence of credentials alone does nothing on normal/local/CI paths, and approval alone is rejected. Never use a production or shared development URL, never run the gate unattended, and never treat local timings as a substitute when the hosted confirmation remains pending.
