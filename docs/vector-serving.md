# Vector serving — sonar, the engine behind every "sounds like"

Every surface that asks _what sounds like this_ — sonic search, `/artists?like=`, the log page's more-like-this, the `/recommendations` draft engine, the `/mix` rail — ranks by cosine similarity over the whole MuQ embedding corpus. That question used to be answered inside the database, as a linear `vector_distance_cos` scan whose cost grows with the catalogue: seconds at scale, and on the broad sonic shape 7–19s with intermittent 500s before it moved. It is now answered by [`apps/sonar`](../apps/sonar/README.md), a Rust service that holds the corpus in RAM and does the scan there.

This doc is the architecture of that stack: the shape and why it is that shape, the contract, the safety contract, the flag map, **what routes with a caveat and what does not**, the freshness/deploy loop, and the two candidates that were built and rejected on measured evidence.

The ranking rule itself is not here — it belongs to [the-ear.md](./the-ear.md) (max-similarity to the single **nearest** probe, never a centroid) and the surface behaviour to [search.md](./search.md). This doc is only about where that math runs.

## The shape: an in-memory exact scan

sonar loads every embedded track's 1024-dim f32 vector into a flat in-memory store, L2-normalized on load so cosine similarity is a plain dot product, and answers a query with a brute-force rayon-parallel scan of the whole thing. No index structure, no approximation. Four properties made that the answer rather than a compromise:

- **The corpus fits in RAM.** ~4KB per vector: roughly 600MB at 150k tracks. A vector database is a solution to a corpus that does not fit near the compute; Fluncle's does. Framed that way the question was never "which vector database" but "where does a small in-memory index live".
- **Exact beats approximate on recall, at no latency cost here.** The scan is 100% recall by construction. An ANN service trades recall away to make a scan sublinear — worth it over a corpus this size only if the linear scan were slow, and it is not.
- **The multi-probe fold is a native inner loop with no topK cap.** A query carries one or more probes and a candidate's score is `max over probes of dot(probe, vector)` — its similarity to the nearest probe, the-ear.md's rule, **never an average**. In the kernel this is one more term in the inner loop. In a hosted ANN service it is N separate topK queries stitched together under a topK ceiling, which is precisely what made Vectorize structurally unable to serve `/recommendations` (see [the measured rejections](#the-measured-rejections)).
- **It cannot live in a Worker.** A Cloudflare Worker isolate is capped at 128MB and has no filesystem, so a 600MB resident index is not an option there under any framing. That single constraint is why this is a box with real RAM behind an HTTP call rather than a module inside `apps/web`.

Measured on real hardware: single-probe **~36ms p50 at 150k** on the box, and **7–8ms at 150k / 44ms at 1M** on a dev machine, at 100% recall. The scan is flat in the catalogue in the sense that matters — it does not drag 4KB blobs through SQL per row, and it does not cross a network per query.

**The division of labour is strict.** sonar returns `{id, score}` and nothing else. It owns no surface logic: the Worker (`apps/web`) decides what to ask, then hydrates the returned ids from Turso by primary key — a flat, cheap lookup — through the same projection the database path uses, so every output DTO is identical whichever path served it. Turso stays the source of truth for everything; sonar is a derived, disposable read replica of one column.

## The contract

`POST /search`, secret-gated. Full wire detail lives in [`apps/sonar/README.md`](../apps/sonar/README.md); the shape:

```json
{
  "index": "tracks",
  "probes": [[0.01, -0.02, "… 1024 floats …"]],
  "filter": {
    "key_in": ["Amin"],
    "bpm_min": 168,
    "bpm_max": 176,
    "anchored": true,
    "certified": true,
    "has_finding": false,
    "dismissed": false,
    "is_duplicate": false,
    "nearest_finding_score_max": 0.995,
    "duration_ms_max": 900000
  },
  "exclude_ids": ["track_abc"],
  "top_k": 20
}
```

→ `{ "matches": [{ "id": "track_xyz", "score": 0.83 }, …] }`, sorted by descending cosine similarity.

- **Two indexes.** `tracks` — one entry per embedded track, keyed by `track_id`, carrying metadata `{ key, bpm, anchored, certified, has_finding, dismissed, is_duplicate, nearest_finding_score, duration_ms }`. `centroids` — one entry per artist centroid, keyed by `artist_id`, carrying no metadata.
- **The filter is ten fields** (`key_in`, `bpm_min`, `bpm_max`, `anchored`, `certified`, `has_finding`, `dismissed`, `is_duplicate`, `nearest_finding_score_max`, `duration_ms_max`), all optional. A set constraint requires the entry to carry that metadata, so any metadata filter naturally excludes centroids. The list grows only when a surface's predicate needs it: **a predicate sonar cannot express is a surface that stays on the database scan**, which is why [the `/recommendations` catalogue scan](#the-recommendations-catalogue-scan-routes-behind-its-own-flag) could not route until the last five arrived.
- **`anchored` = `spotify_uri is not null`.** **`certified` = the track has a `findings` row _with a Log ID_**; **`has_finding` = the track has _any_ `findings` row.** Two different facts, and the difference matters: `findings.log_id` is nullable (a straggler awaiting its coordinate backfill), so that straggler is `has_finding: true, certified: false`. Every public surface filters on the Log ID, so `certified` had to mean the Log ID or a coordinate-less finding could reach a page through sonar that the database path would never have shown; and a predicate meaning "no findings row at all" (`f.track_id is null`) must send `has_finding: false`, because `certified: false` would let that straggler in. The hydrators re-assert `log_id is not null` anyway as defence-in-depth against a stale index.
- **The two range bounds carry OPPOSITE null rules, and both are exclusive** (unlike the inclusive BPM pair), because each mirrors the SQL it replaces. `nearest_finding_score_max` ⇔ `(score is null or score < x)` — **a NULL score PASSES**. `duration_ms_max` ⇔ `duration_ms < x`, and SQL's `NULL < x` is NULL — **a NULL duration FAILS**. Getting either backwards silently changes which rows a page shows, so both are pinned by a test named for the asymmetry.
- **The thresholds are the Worker's, never the engine's.** sonar stores `nearest_finding_score` and `duration_ms` RAW and takes the bound as a value, so `DUPLICATE_SIMILARITY` and `LONG_FORM_MS` stay in `catalogue.ts` where they already live. Tuning one moves the filter and the database predicate together, with no sonar redeploy and no way for the two to drift.
- **An unknown `filter` field is REJECTED** (`deny_unknown_fields`) rather than ignored, and that is a safety property. serde's default is to drop an unknown key, so a Worker sending a constraint an older binary does not know would get back a **wider** candidate set with no error — dismissed, duplicate, or long-form rows on a listener's page, indistinguishable from a correct answer. Failing the parse instead yields the empty result, which every call site treats as the fallback signal, so a Worker/box version skew degrades to the Turso scan: correct, just slower.
- **Bad input is an empty result, never a panic.** Bad JSON, empty probes, a wrong-dimension probe, `top_k: 0` — all return `{"matches": []}`.
- **`top_k` and the probe count are CAPPED, and an over-cap body is a `400`** (`MAX_TOP_K = 1000`, `MAX_PROBES = 32`, `search.rs`). They are the two levers one request can pull to cost the whole box: `top_k` sizes a top-K heap **per rayon worker** under the unit's `MemoryMax=2G`, and each probe is another full dot-product pass over the candidate set. Both caps sit far above every real call — the largest `top_k` any surface sends is `TASTE_SHORTLIST` (300, `/mix`) and the widest probe set is `MAX_REC_SEEDS` (12, `/recommendations`) — so a legitimate caller never sees one. A `400` is deliberately NOT the empty-result signal (that one means "version skew, degrade quietly"); an over-cap request is a caller bug or an abuse attempt and should be visible as a 4xx. It costs the surface nothing either way: `searchSonar` maps every non-2xx to `null`, the same Turso fallback. The Worker mirrors both constants (`SONAR_MAX_TOP_K`/`SONAR_MAX_PROBES`, `sonar.ts`) and falls back **without a fetch** rather than clamping — a silently shrunk `top_k` would hand back a short page that looks correct.
- **`GET /health` is open** (`{tracks, centroids, last_refresh_unix, commit, ok}`), so the box's healthcheck prober can read it without a secret; `POST /search` requires the `x-sonar-secret` header, compared in constant time. Missing or wrong → `401`. **`commit` is the git SHA the running binary was built from** — baked at compile time by the release workflow, `"unknown"` for a local build. It is the pre-flight check for a flag flip: the box self-deploys on an hourly timer, so a merge and a running binary are different moments, and a flag whose route depends on a new filter field must not be flipped until this field reports the commit that added it.

## The safety contract

This is the part to internalise before touching any call site. A surface routes to sonar **only when all three hold**:

1. its dark flag is the **literal string `"true"`** in the `settings` KV — unset, empty, or any other value reads OFF;
2. **both** `SONAR_BASE_URL` and `SONAR_SECRET` are provisioned in the Worker env;
3. sonar actually answers — 2xx, inside the 800ms deadline (`SONAR_TIMEOUT_MS`), with a body that parses to `{matches: [{id, score}]}`.

If any of those fails, [`searchSonar`](../apps/web/src/lib/server/sonar.ts) returns **`null`**, and `null` is a documented answer rather than an error: it means _use the existing path_. The caller falls back to the exact Turso `vector_distance_cos` scan and returns exactly what it returns today. A timeout, a DNS failure, a 401, a garbled body, an unprovisioned local dev machine — every one of them collapses to the same signal, and none of them can take a page down. A well-formed **empty** result comes back as `[]` rather than `null`, and surfaces treat that as a fallback too: a reached surface always has a real probe over a populated corpus, so zero matches is a hiccup, not a true empty neighbourhood.

Two consequences worth stating plainly. **The flags default OFF, so the whole stack is inert until an operator writes `"true"`** — a fresh preview, a local checkout, and an empty database all run the database path. And **falling back can only restore prior behaviour, never worsen it** — the database scan is slow at scale but correct, which is exactly what makes it a legitimate fallback rather than a degraded mode.

Because a surface must fall back rather than approximate, each call site also refuses to route when it cannot reproduce its own predicate in sonar's filter. Sonic search declines whenever the query carries a `key`, `artist`, `album`, `label`, `year`, or free-text filter (key in particular: the database path matches `lower(tracks.key)` against a spread of spellings, sonar compares the raw stored string case-sensitively — near-identical is not identical, so it falls back). `/mix` maps its key set to `key_in` only because `namedMoveKeys` yields the archive's raw stored spellings and sonar stores that same string verbatim. Re-applying a missing predicate during hydration is never the fix: it would prune rows sonar had already counted against `top_k` and silently return a shorter, different page.

## The flag map

One `settings` key per surface, all read default-deny, all in [`sonar.ts`](../apps/web/src/lib/server/sonar.ts).

| Key                            | Surface                                                                                                         | Index       | State                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- | ----------- | -------------------- |
| `sonar_sonic_enabled`          | Sonic search — `sounds like <track>` ([search.md](./search.md) tier 3½)                                         | `tracks`    | **ON in production** |
| `sonar_artists_enabled`        | `/artists?like=` — sounds-like-these-artists                                                                    | `centroids` | **ON in production** |
| `sonar_log_enabled`            | `/log` more-like-this neighbours (certified-only)                                                               | `tracks`    | **ON in production** |
| `sonar_recs_enabled`           | The `/recommendations` draft engine's **findings slots only** (multi-probe over the seeds)                      | `tracks`    | **ON in production** |
| `sonar_recs_catalogue_enabled` | The `/recommendations` draft engine's **catalogue scan** (the whole `REC_ELIGIBLE_WHERE` predicate as a filter) | `tracks`    | Merged, **OFF**      |
| `sonar_mix_enabled`            | The `/mix` rail's candidate scan (key-pre-filtered, both registers)                                             | `tracks`    | Merged, **OFF**      |

**The two `/recommendations` flags are separate on purpose.** The draft engine runs two scans, and they must be commissionable independently: the findings flag is already on in production, so reusing it would have routed the catalogue scan the instant the filter fields merged — before the box's hourly self-deploy had shipped a binary that carries them. (Even that skew is safe, because an older binary rejects the unknown fields rather than dropping them and the surface falls back — but a flag whose pre-condition is "the box has redeployed" has to be flippable on its own.)

**Flipping one is a `settings` row.** `setSonarSonicEnabled` and its five siblings write `"true"`/`"false"` through the same one flag store (`settings.ts`) every other kill switch in the app uses — never a second flag mechanism, and never a deploy. **There is deliberately no `/admin` UI for these yet:** they are commissioning switches, flipped a handful of times each as a surface is proven in production, not an operating control. Add the board when the flipping becomes routine, not before.

**The go-live order for `sonar_recs_catalogue_enabled`** — and for any future flag that depends on a new filter field, because merging the Worker half and running the engine half are different moments:

1. **Merge.** The Worker ships with the flag OFF, so nothing changes: the catalogue scan runs the same exact Turso fold it runs today.
2. **Wait for the self-deploy.** The hourly box timer picks up the CI-built binary, verifies its checksum, pre-smokes it, and swaps it in.
3. **Verify the box carries this commit.** `GET /health` on the engine reports `commit`. It must be the merge commit (or later) — the one that added `has_finding`, `dismissed`, `is_duplicate`, `nearest_finding_score_max`, `duration_ms_max`. Do not infer this from the merge time; read it.
4. **Only then flip the flag.** Flipped early, the engine 401s nothing and errors nothing — it simply rejects the unknown filter fields, returns empty, and every request falls back to Turso. Correct, but you would learn nothing and see no win.

The `/artists?like=` route is worth one note on fidelity: it sends the **same single mean probe** to the `centroids` index that the database path builds, rather than multi-probing over the selected artists. Multi-probe there would be a better answer but a **different** one, and a flag flip must be a pure latency swap. Changing that ranking is a separate, operator-decided slice.

## What routes with a caveat, and what does not

### The `/recommendations` catalogue scan routes behind its own flag

The draft engine runs two scans. The **findings slots** route behind `sonar_recs_enabled`; the **catalogue scan** routes behind `sonar_recs_catalogue_enabled` (merged, OFF — see the go-live order above). This was the last unbounded vector scan in the app, and for a long time it was the one that could not move.

Its eligibility predicate is `REC_ELIGIBLE_WHERE` ([`recommendations.ts`](../apps/web/src/lib/server/recommendations.ts)), shared verbatim with the `/admin/funnel` counter so the two can never drift. It requires: no findings row, an embedding, a Spotify anchor, **not dismissed**, **no duplicate marker**, **under the display-duplicate similarity band**, and **under the long-form veto**. Against the original five-field filter sonar could express exactly one of those — `anchored`. The other four exclusions are **unbounded sets**, so they could not ride along as `exclude_ids` either, and re-applying them at hydration would prune rows sonar had already counted against `top_k`, silently handing back a shorter, differently-ranked page. No faithful routing, therefore no routing.

**All seven clauses now map, one to one**, which is the entire reason the route exists:

| `REC_ELIGIBLE_WHERE`                                        | sonar                                             |
| ----------------------------------------------------------- | ------------------------------------------------- |
| `f.track_id is null`                                        | `has_finding: false`                              |
| `t.embedding_blob is not null`                              | membership in the `tracks` index at all           |
| `t.spotify_uri is not null`                                 | `anchored: true`                                  |
| `t.dismissed_at is null`                                    | `dismissed: false`                                |
| `t.duplicate_of_track_id is null`                           | `is_duplicate: false`                             |
| `(nearest_finding_score is null or < DUPLICATE_SIMILARITY)` | `nearest_finding_score_max: DUPLICATE_SIMILARITY` |
| `t.duration_ms < LONG_FORM_MS`                              | `duration_ms_max: LONG_FORM_MS`                   |

The first row is the trap worth naming: it is **`has_finding`, never `certified: false`**. `certified` means a findings row _with a Log ID_, so a coordinate-less straggler passes "not certified" and fails "no findings row at all" — routing on the weaker negation would have recommended a finding as a catalogue row. The last two rows carry the opposite null rules described under [the contract](#the-contract), and the two thresholds cross the wire as values so they stay owned by the Worker.

**The bar for this route was equivalence, not "it runs."** A fixture world holding one row of every excluded class — dismissed, duplicate-marked, display-duplicate, long-form, on-the-boundary long-form, un-anchored, NULL-score, and the coordinate-less straggler — is scanned both ways, and the routed page must equal the database page row for row, similarity included. (One class cannot be seeded: `tracks.duration_ms` is `NOT NULL`, so a NULL duration is unreachable from the schema; the engine's rule for it is pinned in sonar's own unit tests.)

**The number this exists to move.** The probe count is capped (`MAX_REC_SEEDS` = 12) but the candidate count is not: it grows with every capture and every Spotify anchoring. Measured against production on 2026-07-26, before the route: **9,859 eligible rows, and the scan takes ~1.84s** (a single probe costs ~1.63s, so the folded `min()` shape adds only ~13% for twelve — the cost is dragging 4 KB blobs off disk, not the cosine math, which is why it tracks ROW COUNT almost linearly). That sits inside the file's own tripwire band — **"when it crosses ~5–10k this scan is seconds again"** — and it got there fast: the same figure was ~360 rows on 2026-07-18, before the embed backlog drained. With ~10.7k catalogue rows already Spotify-anchored and ~52k catalogue rows in total, eligibility keeps climbing as embedding coverage completes. **Keep that 9,859 / ~1.84s as the "before"**: the flip is checkable against it.

Because the draft engine runs its two scans **concurrently**, the page could never be faster than this half — so `sonar_recs_enabled` alone improved the findings slots while the catalogue scan set the floor. The other way out remains available and is not mutually exclusive: take the engine off the hot path with a per-user cache keyed by (seed set, corpus fingerprint), the self-healing `rank_catalogue` shape from [the-ear.md](./the-ear.md).

### `/mix` routes with two accepted divergences

`mixRailFromSonar` ([`tracks.ts`](../apps/web/src/lib/server/tracks.ts)) moves only the nearest-neighbour part: sonar returns `TASTE_SHORTLIST` ids nearest the single last-track probe, already key-pre-filtered, each with its cosine; the Worker hydrates their four scoring columns and hands them to the **same** `rankMixRail` the database path uses, so the reason chip, the key/BPM weighting, the texture tiebreak and the DTO are identical. It asks for the shortlist rather than the rail's `limit` on purpose — sonar orders by pure adjacency while the rail orders by mixability × adjacency, so taking sonar's top `limit` verbatim would have made the flag a re-ranking.

Two divergences remain, both accepted and both documented at the function:

1. **sonar indexes only embedded tracks.** An un-embedded key-match — which the database scan still ranks on key and BPM alone — is simply absent from the sonar rail. Routing a vector question to a vector index means the answer is drawn from the tracks that have vectors.
2. **The shortlist is a truncation, and it is live rather than theoretical.** The database scan carries **no limit** — it ranks every key-compatible row in the archive. sonar returns the nearest `TASTE_SHORTLIST` by adjacency, and the key-filtered pool already exceeds that (the key pre-filter admits several Camelot neighbours out of an archive in the tens of thousands). So a candidate with middling adjacency but an excellent BPM fit can place in the database rail's top `limit` and be absent from sonar's shortlist entirely.

**So the flip is a latency swap in _shape_ — same engine, same weighting, same tiebreak — not a guarantee of an identical rail at the tail.** The cap is exactly what makes the query flat as the catalogue grows; the unbounded scan is the thing being replaced, so widening the shortlist to chase parity trades the win away. If the rail ever visibly loses a good mix, raise `TASTE_SHORTLIST`; do not remove the cap.

## Freshness and operations

**Freshness is periodic, ~1 hour.** sonar re-reads both indexes from Turso every `SONAR_REFRESH_SECS` (default 3600) and hot-swaps them atomically, so an in-flight query always sees one consistent snapshot. A newly embedded track is therefore searchable within that window rather than immediately — which is fine, because enrichment is already asynchronous and no surface has needed read-your-write on a fresh embedding. The initial load must succeed at startup (fail fast — there is nothing to serve otherwise); a **later** refresh that fails logs and keeps the current snapshot, so a transient Turso blip never empties the served index.

**The engine self-deploys.** Full runbook in [`apps/sonar/deploy/README.md`](../apps/sonar/deploy/README.md); the loop:

1. **CI builds the artifact.** [`.github/workflows/sonar-release.yml`](../.github/workflows/sonar-release.yml) fires on every merge to `main` touching `apps/sonar/**`, gates the whole run on the monorepo Quality Checks workflow (`needs: [quality]` — `apps/sonar` has no `package.json`, so its `cargo fmt`/`clippy`/`test` live there rather than in `deploy:gate`, and the release waits on that verdict instead of racing it), builds one static musl binary with `-C target-cpu=x86-64-v3` (AVX2 + FMA — for a brute-force dot-product scan, SIMD width _is_ the latency), and publishes three assets to a rolling pre-release: the binary, its `sha256`, and the commit SHA it was built from. The build lives in CI rather than on the box because a Rust release build is ~7–14 minutes on the box's two shared vCPUs — pinned at 100% on the machine that is at that moment serving sonar itself.
2. **The box pulls, verifies, pre-smokes, swaps.** An hourly host timer fetches the published commit SHA, no-ops if it matches what is deployed, otherwise downloads the binary, **verifies its checksum before the binary is executed at all**, boots it in isolation on a loopback port and polls its `/health` until it answers `ok` — which proves in one response that it runs on this CPU, reaches Turso, decodes the blobs, builds both indexes, and serves HTTP. Only then does it snapshot the current binary, swap atomically, restart, and post-smoke. Any post-swap failure **rolls back** to the snapshot; a failed rollback fires the loudest alert and stops for a human. The repo is public, so all three assets are fetched by unauthenticated `curl` — no GitHub token ever goes on the box.

**What a swap costs the surfaces, and it is worth knowing before hunting a latency spike that lines up with the timer's hour:** the restart takes the engine away for as long as it needs to re-read the whole corpus (~30s today, growing with it), and again if it rolls back. **For that window every routed surface sees an unreachable engine, treats it exactly like a disabled flag, and falls back to the Turso exact scan.** Results stay correct; they just get slower. That is not an outage — it is the safety contract doing its job.

**Two rows on the public `/status` board**, deliberately split: **`Sonar`** is the engine's own liveness (the prober GETs `/health` at the engine's public base URL, read from its own env file, and counts it up only when the body parses and `ok` is `true` — a reachable-but-unbuilt engine reads as **down**, which is the state worth catching), and **`Self-deploy (sonar)`** is the freshen timer reporting each run (`ok` when current or freshly deployed, `degraded` when a verify/pre-smoke failed or a swap was rolled back, `down` if a rollback itself failed). If the timer stops, that row simply goes stale — itself the signal that the engine may be silently drifting.

**Where the secrets live.** The engine's public base URL and shared secret are a Worker secret plus a `0600` env file on the box; the Turso read credentials, the port, and the TLS paths are in that same env file. None of them are in this repo, and the deploy loop reads the env already on the box rather than provisioning any.

## The measured rejections

Two candidate fixes were **built and measured before this architecture was chosen**, and both were rejected on evidence. Recorded here because the numbers exist nowhere else and the decisions should not be re-litigated from first principles. Everything below is **measured, not modelled**.

### Cloudflare Vectorize — a managed edge ANN service (2026-07-23, real Cloudflare infrastructure, torn down)

- **Latency, approximate mode at 150k:** ~150–180ms p50, ~170–225ms p95, with a **hard floor of ~147ms even warm**. Nothing sub-100ms was reachable.
- **Latency, high-precision mode:** 287ms p50, **806ms p95**.
- **Recall** (13.4k real embeddings, overlap@K against an exact scan): approximate **74–80% @10**; high-precision 99% @10 but only ~79–86% @50.
- **Structurally unable to serve the multi-probe fold.** `topK ≤ 100` against a 115-row pool with a 24-probe fold: the shape `/recommendations` needs does not fit the API at all.

Wrong tool for exact, multi-probe, sub-100ms work at this scale.

### Hardening the in-database scan in place (2026-07-23, real hosted Turso; the PR was closed)

The presumed near-term win: make the existing exact scan cheap enough that no infrastructure has to move. The technique tested was an **int8 coarse scan plus an exact float32 rescore** — store a 4×-smaller quantized code beside the float32 blob, scan the codes, take the top-N with 8× overfetch, rescore those N with the full vectors. (`FLOAT1BIT` was checked and ruled out first: it ranks only with jaccard/hamming, not cosine.)

- **Recall: solved.** 100% top-12 across every shape tested. Int8 coarse + overfetch + exact rescore is a correct design, and that is the surviving learning — worth reaching for if a per-region index ever has to shrink.
- **Latency: not solved.** Per-shape p50 on a 20k smoke over a flaky link, so the absolutes are inflated and the _relative_ story is the structural one: **sonic broad** (anchored-only, ~70% of rows) 2543ms → 1902ms, i.e. int8 bought only **~25%**; **sonic narrow** (key + anchored, ~3%) 112ms → **196ms — slower**, because a double round-trip is a bad trade on a small scan; **recommendations** (12-probe, ~70%) 720ms → 689ms, roughly equal.

**Why it cannot be rescued:** the int8 coarse pass is still a _full SQL scan_. The cost is **per-row SQL cosine × N rows plus the cross-region round-trip to the primary — not blob I/O** — so shrinking the vector 4× cannot change the order of magnitude, and no btree pre-filter narrows the broad "sounds like X" case (it filters little beyond `anchored`). The SQL-scan model is the ceiling.

**Both rejections point the same way:** a remote or SQL-side scan cannot hit the bar at this scale, whatever is done to the vectors. The in-memory index near the compute is the one path the evidence leaves standing — and the corpus being small is exactly what makes it cheap. The database-side traps that shaped the fallback path (bind the probe as a raw BLOB, never `libsql_vector_idx` on a populated table, never rank in the isolate, never fan probes out as `union all`) are in [local-database.md](./local-database.md).

## What is still unbuilt

- **Regional replication is demand-gated and untriggered.** One region today. The index is small enough that adding a region is cheap — spin a box, pull the binary, register it — but a second one is only correct once far-region **dynamic** (uncached search/recs) traffic is a measured, meaningful share; you cannot place a replica without knowing where the audience is. The Worker calls the engine directly at one region; a geo-steered load balancer is the recommended mechanism if a second is ever added. Note the constraint that makes the split worth anything: the Worker→engine hop must be **same-continent** — a cross-ocean hop would eat the entire win.
- **The `/recommendations` catalogue route is merged but not yet commissioned.** The filter fields exist and the equivalence is proven; what remains is operator work, in order: let the box self-deploy, read `commit` off `GET /health`, then flip `sonar_recs_catalogue_enabled` and check the page against the 9,859-rows / ~1.84s baseline. Until that flip the last unbounded vector scan is still running in the database.
