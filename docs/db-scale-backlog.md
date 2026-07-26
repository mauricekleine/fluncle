# DB query-shape scale backlog

Proactive audit (2026-07-24, 8-family multi-agent workflow: 47 findings verified → 35 survived adversarial refutation → 29 deduped items). Target: 150k tracks. Non-canonical planning; supersedes the reactive triage.

STATUS (2026-07-26): everything proven has SHIPPED LIVE — the Wave-1 pure hoists (#847/#848), the cheap #858 index/rewrite batch, the four proven indexes (#857), and Keystone 1's maintained `is_catalogue` flag (#859, prod-verified: the `is_catalogue = 0` count matches the `findings` count exactly). Five Wave-1 index items are DEFERRED — proven on hosted 150k NOT to help as-specified. Keystone 2 is proven and recommended but not built; its write-side maintenance cost is the one unmeasured axis. Shipped items are collapsed into "Shipped (live)" below (their full pre-fix loc/shape analysis is preserved in git history); everything still outstanding keeps its detail. Prune items as they ship.

## Root verdict

CONFIRMED — the root is recompute-by-full-scan on grown tables, and it collapses to two shapes, both consequences of the tracks/findings subtype split: (A) the catalogue anti-join `tracks LEFT JOIN findings WHERE findings.track_id IS NULL` (equivalently `NOT EXISTS (SELECT 1 FROM findings …)`) with NO materialized "is-catalogue" discriminator, which forces a full left-join scan of the growing tracks table — this is the most-repeated shape in the audit and it drives the largest measured costs (the ~31s/19s/14s rank-sweep walls, up to 8×/tick, plus crawl status, the funnel scans, the search entity gate, and the Apple/fresh feeds); and (B) the O(tracks)/O(track_artists) grouped `having` scan behind the catalogue-scale entity hubs (labels/albums/artists), reused verbatim by the web hub, the public API list ops, the MCP browse, and the sitemap. The SINGLE denormalization that kills the largest share is a maintained per-track `is_catalogue`/`certified` flag with a partial index: it converts every `findings.track_id IS NULL` from a full scan into a seek, retiring shape (A) everywhere at once — the biggest recurring cost in the app (now Wave-2 Keystone 1, SHIPPED via #859). The per-entity `renderable_track_count`/`certified_finding_count` columns are the close-second keystone, retiring all of shape (B) in one stroke (web hub + API + MCP + sitemap + bio worklists + the search entity gate) — now Wave-2 Keystone 2, proven and recommended. Important nuance for sequencing, borne out by the ship data: the rank-sweep walls were ALSO substantially retired by the Wave-1 pure hoists alone (short-circuit countStale off batch-fullness, gate computeCatalogueCounts to the drain-end branch with a per-tick bucket delta, compute readArchiveAffinity once per call) — those removed 7-of-8 full scans per tick with zero schema change and zero dependence on Turso's (absent) planner stats, so Wave 1 bought the biggest immediate relief (SHIPPED via #847/#848) while the Wave-2 is_catalogue flag makes the residual scan and every on-demand consumer seek-fast and future-proof.

## Shipped (live)

The Wave-1 pure hoists (#847/#848), the cheap #858 index/rewrite batch, the four proven indexes (#857), and Keystone 1 (#859). Done, no longer outstanding; the full pre-fix loc/shape/impact/fix analysis is in git history.

- **1 — Rank sweep: short-circuit countStale off batch-fullness** — #847/#848.
- **2 — Rank sweep: gate computeCatalogueCounts to the idle branch + per-tick bucket delta** — #847/#848.
- **3 — Crawl tick: stop calling getCrawlStatus + split frontierByKind out** — #847/#848.
- **4 — Rank sweep: compute readArchiveAffinity once per call** — #847/#848.
- **5 — Funnel: fold gatherLiveFunnel's three full scans into one conditional-aggregate pass** — #847/#848.
- **6 — Demand nightly batch: PK point-lookup promotion (#858) + the `<>1`→`=0` partial-index CLEAR with `crawl_frontier(state) where demand_rank = 0` (#857)** — both halves shipped; the nightly clear now seeks the promoted rows instead of touching all ~90k.
- **7 — Fresh feed: swap the fat TRACK_SELECT for LEAN_TRACK_SELECT** — #847/#848.
- **8 — findSeedTrack: split the cross-table OR into two indexed seeks** — #858.
- **9 — Crawl status count via count(tracks) − count(findings)** — #858.
- **10 — compileFilters: sargable year-range rewrite (substr → range)** — #858.
- **13 — Catalogue Apple-URL worklist: drop coalesce() from ORDER BY** — #858. Only the ORDER BY rewrite shipped: with coalesce dropped, `order by capture_priority desc, track_id` rides the EXISTING `tracks_capture_priority_track_id_idx`. The proposed NEW partial index (`tracks_catalogue_apple_queue_idx`) was NOT picked by the planner and was dropped.
- **11 — artists.name NOCASE COVERING index** — #857. `artists_name_nocase_idx on artists (name collate nocase, slug)`. The `+slug` COVERING trailer is what flipped the plan: a bare `(name collate nocase)` index did NOT (the join still scanned all artists to fetch slug). Decouples every `/label/<slug>` render from total artist count.
- **16 — rearmSeedLabels: label-node partial index** — #857. `crawl_frontier(state, done_at) where kind = 'label' and source = 'musicbrainz'`; measured 5.8× — the every-tick pick seeks the tens of label nodes instead of residual-scanning the ~90k done partition.
- **18 — artist_socials candidate queue: partial index** — #857. `artist_socials(artist_id) where status = 'candidate'`; the distinct-artist read seeks the rare candidate slice instead of scanning most of the table.
- **Keystone 1 — maintained `is_catalogue` flag + partial index** — #859. Materializes the catalogue anti-join (`findings.track_id IS NULL` → `is_catalogue = 1`); 5.7× on the catalogue count at 150k. Written at the certify/publish sites atomically with the `findings` insert (so the invariant is never briefly violated), backfilled certified-only via the findings-driven `where track_id in (select track_id from findings)` shape (660ms — NOT the 97s full-table `EXISTS` form), and consumed by the rank sweeps, the `/fresh` catalogue half, the Apple worklist, and the `/tracks` hub certification filter. Prod-verified after deploy: the `is_catalogue = 0` count equals the `findings` count exactly.

## Wave 1 — outstanding (all DEFERRED: proven on hosted 150k NOT to help as-specified)

Every Wave-1 item that proved out has shipped (see "Shipped (live)" above). What remains here is the five the hosted proof gate REJECTED — kept with their analysis so nobody re-proposes them blind. Do not ship any of these as-specified.

**12. Analyze worklist: partial index mirroring tracks_embed_queue_idx**
`tier=cheap · tracks · T1, T9, T2`
**STATUS: DEFERRED — proven on hosted 150k NOT to help as-specified; do NOT ship as-is.** Even after widening the partial-index predicate to match the query's `analyzed_at is null` disjunct exactly, the planner still won't pick it — the WORK_ORDER `ORDER BY` forces a table read (the sort columns aren't in the index). Making it earn its keep needs an explicit `INDEXED BY` hint — a design call.

- loc: apps/web/src/lib/server/track-work.ts:385-392 (kindClause analyze) + countTrackWork:566-572; funnel.ts:264
- shape: `source_audio_key is not null and (analyzed_at is null or analyzed_from is null or analyzed_from<>'full')` has NO covering index (embed has one) → scans captured rows every enrich tick + once/day in the funnel.
- impact: was HIGH-certainty on the backlog bound; the index builds fine but the sort defeats its selection.
- fix (deferred): `tracks_analyze_queue_idx on tracks(track_id) where source_audio_key is not null and (analyzed_at is null or analyzed_from is null or analyzed_from<>'full')` — the widened predicate matches the query, but the query still needs `INDEXED BY` to use it. Revisit as a design item alongside the WORK_ORDER sort shape.

**14. Capture terminal-status lenses: partial index on capture_status**
`tier=cheap · tracks · T9, T1, T6`
**STATUS: DEFERRED — proven on hosted 150k NOT to help as-specified; do NOT ship as-is.** The anti-join drives a full scan and the maintained is_catalogue flag does NOT enable the selective composite — proven in a spike.

- loc: apps/web/src/lib/server/catalogue.ts:2253-2279 (quarantine/unmatched/failed lenses), apps/web/src/lib/server/catalogue.ts:2583-2600 (requeueUnmatchedCaptures)
- shape: `capture_status in ('wrong-audio','unmatched','failed')` is unindexed → each admin lens load is a full anti-join scan; quarantine also sorts on unindexed catalogue_ranked_at.
- impact: MEDIUM-HIGH — admin lens loads; but the composite couldn't be selected against the anti-join.
- fix (deferred): the proposed partial index `on tracks(capture_status, catalogue_ranked_at) where capture_status in ('wrong-audio','unmatched','failed')` does not enable the lens because the catalogue anti-join full-scans first; revisit once Keystone 1 lands and the anti-join is a seek.

**15. tracks(label_id, release_date) composite index (label cover subquery + per-label fresh feed)**
`tier=cheap · tracks · T5, T9, T6, T3`
**STATUS: DEFERRED — proven unused + expensive to build; drop it.** The composite is unused because of the `release_date is null asc` lead term in the cover's ORDER BY, AND it took 24s to build at 150k.

- loc: apps/web/src/lib/server/labels.ts:492 (LABEL_CATALOGUE_COVER_JSON), used :883/:598, apps/web/src/lib/server/fresh-entity.ts:103-115 (unlit label branch)
- shape: Both seek `label_id` via tracks_label_id_idx then SORT by release_date (no composite index) — the cover `limit 1` sorts a big imprint's rows per tile; the fresh feed fetches a mega-label's ENTIRE all-time subset then post-filters the 30-day window + temp-sorts (limit bounds only output, not the scan/sort).
- impact: MEDIUM — but the proposed composite doesn't serve the cover's ORDER BY.
- fix (deferred): the proposed `tracks(label_id, release_date [, track_id])` composite is unused because the ORDER BY leads with `release_date is null asc`; and it is a 24s build at 150k. Drop it. If the cover/per-label-feed cost bites, revisit with an ORDER BY that the index can serve.

**17. Artist review queue: (reviewed_at, created_at) index + bounded head walk**
`tier=cheap · artist_socials · T2, T6`
**STATUS: DEFERRED — the index alone can't help the GROUP-BY; needs the bounded-head-walk rewrite (a design call).**

- loc: apps/web/src/lib/server/artists.ts:1659 (listArtistReviewRows)
- shape: GROUP BY artist + min(created_at) + ORDER BY the aggregate over ALL unreviewed socials before LIMIT 25 — every resolver-minted link is born reviewed_at NULL and stays, so the unreviewed set grows with every crawl-resolved artist.
- impact: MEDIUM — attention-queue read.
- fix (deferred): the `(reviewed_at, created_at)` index does not bound the aggregation on its own; the real fix selects the oldest-N DISTINCT artist_ids from the null-reviewed group via a bounded index walk, then aggregates only those ≤25 artists — a query rewrite (design). Wave-2 fallback: a maintained unreviewed-artists worklist the resolver writes into.

**19. Ear lens: partial index skipping the near-1.0 duplicate prefix**
`tier=cheap · tracks · T4, T1`
**STATUS: DEFERRED — low value; drop it.** The partial index IS used but the gain is marginal and it took 16s to build at 150k.

- loc: apps/web/src/lib/server/catalogue.ts:2242-2251 (ear lens) + :2229 (fetchLimit)
- shape: Walks tracks_nearest_finding_score_idx DESC but `duplicate_of_track_id is null` + the anti-join are residuals; deterministic duplicates score ~1.0 and cluster at the index head, so the walk reads the whole growing duplicate prefix (each a PK anti-join + residual) before yielding real discoveries.
- impact: LOW — the partial index works but the measured gain doesn't justify a 16s build.
- fix (deferred): the proposed `on tracks(nearest_finding_score) where duplicate_of_track_id is null and nearest_finding_score is not null` is used but marginal; drop it. Revisit if the duplicate prefix grows enough to matter.

## Wave 2 — denormalizations (stored/maintained columns; ranked by blast radius × certainty)

**1. KEYSTONE — per-track `is_catalogue` flag — SHIPPED (#859).** See "Shipped (live)" above. Two consumers were deliberately left on the anti-join: `funnel.ts` (its findings join is pinned by the `certified` arm and the shared `kindClause`, so converting buys nothing) and `search.ts`'s entity gate (its `findings.track_id is null` lives inside the shared `HUB_RENDERABLE` group-by — Keystone 2's territory).

**2. KEYSTONE — per-entity renderable_track_count + certified_finding_count on labels/albums/artists (kill the hub group-by)**
`tier=denormalize · tracks (labels/albums hubs); track_artists (artists hub, ~2× tracks) · T2, T1, T3, T6`
**STATUS: RECOMMENDED — PROVEN at 150k, not built.** Measured 5.8× (labels hub) / 46× (artists hub, over ~225k track_artists edges). Build on merged Keystone 1.

- loc: apps/web/src/lib/server/labels.ts:795/824 (listHubPage) + :979 (listCatalogueBrowsePage), apps/web/src/lib/server/labels.ts:1217 / albums.ts:491 / artists.ts:541 (API list ops + MCP browse), apps/web/src/lib/server/labels.ts:588 / albums.ts:378 / artists.ts:341 (sitemap rows), sitemap-data.ts:134, apps/web/src/lib/server/search.ts:388-411 (entity hub gate), apps/web/src/lib/server/labels.ts:1567 (…MissingBio worklists ×3)
- shape: `entity ⋈ tracks left join findings group by entity having (sum(certified)>0 or renderable>=floor)` — an O(tracks)/O(track_artists) grouped scan re-run on EVERY hub ?page=N (uncached on the API/MCP path), every sitemap request, the search entity gate (uncorrelated IN(GROUP BY) → materialized once per exec, up to 4-6× per search), and the bio worklists (per-row correlated subqueries).
- impact: KEYSTONE — retires the entire catalogue-scale entity-list family in one stroke.
- key fact (semantics): "renderable" = certified + catalogue = the TOTAL linked-track count, with NO dismiss/duplicate exclusion — confirmed from HUB_RENDERABLE + the count query. So the maintained counts react ONLY to edge-moves (link/relink) + certify; there is no dismiss/duplicate term to track. This is what makes the maintained-delta design tractable.
- recommended design (not built): maintained `renderable_track_count` + `certified_finding_count` (or a `certified` bool) on labels/albums/artists rows, written as DELTAS by the edge-moving paths (publish stamps label_id/album_id/track_artists; crawl link; dismiss; duplicate-mark; merge), a one-time backfill, PLUS a self-healing reconciliation sweep that periodically recomputes-and-corrects (a counter-drift backstop — the maintained-counter failure mode). The gate then filters/orders the small entity table by stored columns — no tracks join, no group-by, slug-orderable, pager offsets over the entity table alone. Shared HUB_INCLUSION_HAVING/HUB_RENDERABLE fragments mean one column set fixes web hub + API + MCP + sitemap + bio + the search gate at once. hubFindingCountsBySlug / hubCountsBySlug stay as bounded slug-in reads. Build on merged Keystone 1.
- **slice A (write side + backfill) — SHIPPED (#880):** the two columns on labels/albums/artists, delta-maintained by every edge-writing path (`apps/web/src/lib/server/hub-counts.ts`) + the one-time `scripts/backfill-hub-counts.ts` seed.
- **slice C (the reconciliation sweep) — SHIPPED:** the AGENT-tier `reconcile_hub_counts` op (`POST /admin/hub-counts/reconcile` → `apps/web/src/lib/server/hub-counts-reconcile.ts`) + the nightly `fluncle-reconcile-hub-counts` box cron at 04:10 Amsterdam. Two statements per table — a grouped `UPDATE … FROM (… GROUP BY fk)` guarded by a counts-DIFFER predicate (so `rowsAffected` IS the corrected-row count) plus a zero-truth pass for an entity whose last track vanished out of band. The artists source is PINNED to `track_artists ⋈ tracks`, never raw edges: prod carries 62 ORPHANED edges (out-of-band track deletion, measured 2026-07-26) and every hub read joins `tracks`, so counting raw edges would "correct" the counters into disagreeing with what renders. Slice A's own rollout day proved the sweep's necessity: the deploy-window skew left 44 artists / 3 albums / 1 label wrong until a manual reconcile. The corrected-row counts are logged per tick as the operator's drift audit (`journalctl -u fluncle-reconcile-hub-counts.service | grep AUDIT`).

**3. Rank sweep: match_key + needs_rank tracks columns** · **needs hosted proof**
`tier=denormalize · tracks · T3, T1, T4`
**STATUS: RECOMMENDED — not built.**

- loc: apps/web/src/lib/server/catalogue.ts:968 (readCatalogueIdentity, match_key), apps/web/src/lib/server/catalogue.ts:1133 (candidateResult, needs_rank)
- shape: readCatalogueIdentity builds a full-catalogue byMatchKey duplicate map by scanning all captured rows (~31s); candidateResult's `catalogue_rank_corpus <> ?` predicate can never ride a btree, so the idle/near-drained tick full-scans the PK to return empty, dragging the inline embedding_blob.
- impact: HIGH — retires the ~31s identity scan and makes idle ticks free.
- fix: Two maintained columns: (a) `match_key` text (mirror of matchKey(), written on every mint/update) + index → duplicate resolution becomes per-candidate indexed equality seeks over the batch instead of a full-catalogue map (the ISRC half already has tracks_isrc_idx). (b) `needs_rank` boolean (set when corpus/vector changes, cleared when stamped) + partial index `where needs_rank` → the stale fetch seeks exactly the stale set and the idle tick costs O(0). Pairs with the is_catalogue keystone.

**4. Anchor worklist: has_embedding column + partial index** · **needs hosted proof**
`tier=denormalize · tracks · T1, T6`
**STATUS: RECOMMENDED — not built.**

- loc: apps/web/src/lib/server/track-work.ts:244 (ANCHOR_ORDER), listTrackWork:434
- shape: ANCHOR_ORDER leads with `(embedding_blob is not null) desc` — a raw expression that can't be a btree leading key — so the hourly anchor sweep materialises the whole un-anchored set (bulk of ~48k→150k, shrinks only as metered Apify anchoring catches up), table-probes each row for blob null-ness, sorts, returns 200.
- impact: HIGH — hourly, and the backlog grows with the catalogue.
- fix: Add `has_embedding` INTEGER (0/1) maintained wherever embedding_blob is written/cleared (embed write + wrong-audio quarantine); add partial index `(has_embedding desc, nearest_finding_score desc) where spotify_uri is null` and rewrite ANCHOR_ORDER to `has_embedding desc, nearest_finding_score desc nulls last, track_id asc` so the partial-index walk satisfies the ORDER BY prefix and LIMIT short-circuits at 200.

**5. tracks-hub year lane: maintained year→renderable-count rollup** · **needs hosted proof**
`tier=denormalize · tracks · T2`
**STATUS: RECOMMENDED — not built.**

- loc: apps/web/src/lib/server/tracks-hub.ts:587 (tracksHubYearLaneQuery)
- shape: `group by substr(release_date,1,4)` reads all ~48k→150k index entries per cold 60s window (non-sargable group key) — always rendered unfiltered.
- impact: MEDIUM.
- fix: Maintain a tiny `year → renderable count` rollup (refreshed on certification/write or the nightly cron) and read it for the unfiltered lane instead of grouping the whole table; keep the 60s TTL memo for the rarer filtered variants.

**6. Capture worklist: `capturable` flag (open-budget catalogue capture)** · **needs hosted proof**
`tier=denormalize · tracks · T1, T3, T6`
**STATUS: RECOMMENDED — not built (only bites once catalogue capture is opened).**

- loc: apps/web/src/lib/server/track-work.ts:328-372 (capture kindClause), apps/web/src/lib/server/funnel.ts:264 (capture catalogue count)
- shape: When the capture budget is OPEN, `capture_status is null` (crawler-minted rows carry no status) is non-selective and the finding∨catalogue OR + certified-first ORDER BY aren't index-served → full scan+sort per capture tick.
- impact: MEDIUM — only bites once the operator opens catalogue capture.
- fix: Maintain a `capturable` flag / partial index so capture_status stops being an unindexed leading predicate, and pair with the is_catalogue keystone for the catalogue arm. Note: overlaps the Wave-3 capture split-OR design; the flag is the denormalize path, the isolate-merge is the design path — decide together. Default-shut brake stays (keeps the common case cheap today).

## Wave 3 — design calls (need a decision / larger refactor; ranked by impact)

**1. Recommendations: per-user cache off the request hot path (non-vector half)**
`tier=design · tracks (+ findings anti-join) · T1, T3, T7`
**STATUS: DESIGN — recommended, pending a decision.**

- loc: apps/web/src/lib/server/recommendations.ts:107 (REC_ELIGIBLE_WHERE) + :514 (catalogueScan)
- shape: The per-user catalogue scan filters candidates by an anti-join + predicates with NO partial index over the eligible slice, then drags every survivor's 4KB embedding_blob through vector_distance_cos; candidate count is unbounded. The file's own tripwire: ~360 eligible today, but 'when it crosses ~5-10k this scan is seconds again.'
- impact: HIGH — /recommendations hot path; the file's declared scale wall.
- fix: Per-user cache keyed by (seed set, corpus fingerprint) — the rank_catalogue self-healing precompute shape the file names as the exit — so the engine leaves the request hot path; and/or a partial index over the rec-eligible slice to bound the anti-join. The vector_distance_cos math is vector-rfc's SIMD sidecar (owned); the candidate-set materialization/caching + anti-join pre-filter are the unowned half here.

**2. Search compileFilters: resolve name filters to indexed ids + key canonicalization** · **needs hosted proof**
`tier=design · tracks · T1, T9`
**STATUS: DESIGN — recommended, pending a decision.**

- loc: apps/web/src/lib/server/search.ts:645-648 (artist LIKE), apps/web/src/lib/server/search.ts:651-656 (label/album lower()) + :659-668 (key lower()), runFilters:712 + rankTracksByVector:838 pre-filter
- shape: The artist filter is `lower(artists_json) like '%'||?||'%'` — a leading-wildcard LIKE over unindexed JSON → full 48k→150k scan on the SINGLE most common search shape (every exactly-named artist). label/album `lower(tracks.label/album)=?` and `lower(tracks.key) in (…)` wrap columns and defeat the btrees that exist.
- impact: HIGH — the hottest, most common search shape.
- fix: artist: resolveEntity already holds artists.id → filter `tracks.track_id in (select track_id from track_artists where artist_id=?)` (track_artists_artist_id_idx); tier-4 LLM path resolves the emitted name to an id first, substring only as fallback. label/album: filter the resolved `tracks.label_id`/`album_id` (indexed) instead of the raw string. key: store a canonical/lowercased key form and index it (verify hosted). Requires threading ids through compileFilters — a design change. (The year clause was the Wave-1 cheap rewrite, now shipped.)

**3. tracks-hub numbered pager: keyset/seek pagination for the deep tail** · **needs hosted proof**
`tier=design · tracks · T6, T1`
**STATUS: DESIGN — recommended, pending a decision.**

- loc: apps/web/src/lib/server/tracks-hub.ts:445 (tracksHubIdPageQuery), executed :507
- shape: Numbered ?page=N via OFFSET over the whole archive: 48k→~1000 pages now, 150k→~3100 pages; a crawler following the pager to the tail walks up to ~144k index entries per request (O(offset)). The hosted ship-bench only proved 25k / offset ~20k unfiltered — 150k tails + a non-sargable filter were never proven.
- impact: MEDIUM-HIGH — the crawler-facing pagination scale wall.
- fix: Give the crawl-facing deep tail keyset/seek pagination: a cursor on (release_date, track_id) with `where (release_date, track_id) < (?, ?)` rides tracks_release_date_idx with zero offset walk; or cap max reachable ?page and route the tail through year-lane jumps + filters. If numbered OFFSET is kept as a deliberate choice, re-prove at 150k WITH a non-sargable filter active.

**4. Capture worklist: split the finding∨catalogue OR into two ordered streams merged in the isolate** · **needs hosted proof**
`tier=design · tracks · T1, T6, T3`
**STATUS: DESIGN — recommended, pending a decision (gated behind opening catalogue capture).**

- loc: apps/web/src/lib/server/track-work.ts:328-372 (capture) + :434 (listTrackWork) + countTrackWork:566
- shape: Open-budget capture: one query must serve a two-branch OR (findings arm ∨ catalogue arm) plus a certified-first ORDER BY prefix `(f.track_id is not null) desc` that isn't index-served → full scan+sort per tick. countTrackWork is a full scan (the module admits capture/analyze counts scan).
- impact: MEDIUM — gated behind operator opening catalogue capture.
- fix: Keep the default-shut brake. For open-budget: drive the findings arm from `findings` (PK join) and the catalogue arm from tracks_capture_priority_track_id_idx (partial, walking capture_priority desc), filter capture_status/duration/dismissed as residuals, and INTERLEAVE the two ordered streams (findings first) in TS instead of one ORDER BY the planner must sort. Pairs with the Wave-2 capturable flag — decide flag-vs-merge together.

## Owned elsewhere — do NOT touch

- already-fixed — catalogue.ts:1183 rankCatalogue max-similarity vector cross-scan (finding_vec/candidate_vec CTEs) + the RANK_BATCH_SIZE=250 batch write. CONFIRMED mitigated: both CTE arms carry `as materialized`, the join is a `cross join` pinning findings (small) as the driver with the `embedding_blob is not null` guards moved inside the CTEs, and the batch write is bounded/single-row/PK-keyed/idempotent under the single-writer box sweep. Do NOT re-flag as new.
- artist-session — backfill-artist-images.ts:55 listWork (`select … from artists where image_url is null and spotify_artist_id is not null order by id limit ?`): the avatar-fill worklist scans artists on the unindexed `image_url is null`. Owned by the artist edges/credits/visibility session; shape noted only.
- vector-rfc — the vector_distance_cos math in recommendations.ts listRecommendations catalogueScan (recommendations.ts:514) and any getSimilarFindings / list_similar_tracks / sonic-search / similarity ranking. The in-memory SIMD sidecar owns ALL vector distance. Only the NON-vector shape around it — the REC_ELIGIBLE_WHERE anti-join pre-filter and the per-user candidate-set cache — is in this backlog (Wave 3-1). Do not touch the distance computation.

## Guardrail (so this can't re-accrue)

**STATUS: PENDING — builds LAST, once the keystones' final state is settled.** The forbidden-shape allowlist and the audit domain both key off the keystone columns, so this lands once Keystone 2's columns are final. Keystone 1's `is_catalogue` has shipped (#859), so the allowlist can already treat an unguarded catalogue anti-join as a violation — with the two deliberate survivors (`funnel.ts`, and `search.ts`'s gate until Keystone 2 lands) as explicit, shrinking allowlist entries.

Two concrete, complementary mechanisms so this debt can't silently re-accrue. (A) A BUILD-FAIL vitest, new file `apps/web/src/lib/server/db-query-shape.test.ts`, modeled 1:1 on the existing `apps/web/src/lib/server/orpc-coverage.test.ts` and already executed by `bun run test` inside `deploy:gate` (package.json:54 → `format:check && lint && typecheck && test && test:scripts`), so a violation aborts the Cloudflare deploy build the same way an uncovered oRPC route does. It statically scans the server SQL surface (`apps/web/src/lib/server/**`, `apps/web/src/db/**`) for the forbidden shapes on the four growing tables (tracks, crawl_frontier, track_artists, findings-as-anti-join) and fails on any NEW occurrence not on an explicit, SHRINKING allowlist — exactly the PENDING-list enforcement the oRPC coverage tests use (an entry must map to a real occurrence; the list must shrink as Wave 1/2/3 land). Flagged shapes: the unmaterialized catalogue anti-join (`findings.track_id IS NULL` or `not exists (select 1 from findings …)` without an accompanying `is_catalogue`/`certified` predicate), function-wrapped filter columns that defeat btrees (`lower(tracks.`, `substr(tracks.release_date`, `like '%' ||` over tracks/track_artists), an `OFFSET` bind on the tracks-hub pager, `select *` / the fat TRACK_SELECT on a public list read, `create index … libsql_vector_idx` against a populated table, and a query vector bound as text rather than blob (the docs/local-database.md traps). Couple it to a hosted-proof gate: any allowlisted `needsHostedProof` index must be validated against a scratch hosted-Turso DB via the existing `apps/web/scripts/bench-db-scale.ts` pattern (never local-green) before the allowlist entry is removed. (B) Add a `db-query-shape` domain to the nightly self-audit rotation: append `"db-query-shape"` to the `DOMAINS` array in `docs/agents/hermes/scripts/audit/rotation.ts` (7→8; the file documents the exact three-step add — key + `prompts/<key>.md` + `DOMAIN_META` entry), author `docs/agents/hermes/scripts/audit/prompts/db-query-shape.md` from this spec's T1–T9 taxonomy + the four growing tables + the hosted-Turso reality rails + the vector-rfc/artist-session ownership boundaries, and reflect the new domain in `packages/skills/fluncle-audit-operator/SKILL.md` and `docs/agents/hermes/audit-timer/README.md`. The audit catches the SEMANTIC recompute-by-scan a grep can't (a new O(tracks) group-by reached through a helper, an anti-join via a view, a per-row correlated subquery in a loop) and either fixes it on green CI or files it to `docs/audit-backlog.md`. Together: the test is the hard gate (a new unguarded growing-table scan fails the deploy), the audit domain is the recurring deep sweep (judgment shapes + hosted-proof follow-through).
