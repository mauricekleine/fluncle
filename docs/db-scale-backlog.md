# DB query-shape scale backlog

Proactive audit (2026-07-24, 8-family multi-agent workflow: 47 findings verified → 35 survived adversarial refutation → 29 deduped items). Target: 150k tracks. Non-canonical planning; supersedes the reactive triage. Prune items as they ship.

## Root verdict

CONFIRMED — the root is recompute-by-full-scan on grown tables, and it collapses to two shapes, both consequences of the tracks/findings subtype split: (A) the catalogue anti-join `tracks LEFT JOIN findings WHERE findings.track_id IS NULL` (equivalently `NOT EXISTS (SELECT 1 FROM findings …)`) with NO materialized "is-catalogue" discriminator, which forces a full left-join scan of the growing tracks table — this is the most-repeated shape in the audit and it drives the largest measured costs (the ~31s/19s/14s rank-sweep walls, up to 8×/tick, plus crawl status, the funnel scans, the search entity gate, and the Apple/fresh feeds); and (B) the O(tracks)/O(track_artists) grouped `having` scan behind the catalogue-scale entity hubs (labels/albums/artists), reused verbatim by the web hub, the public API list ops, the MCP browse, and the sitemap. The SINGLE denormalization that kills the largest share is a maintained per-track `is_catalogue`/`certified` flag with a partial index: it converts every `findings.track_id IS NULL` from a full scan into a seek, retiring shape (A) everywhere at once — the biggest recurring cost in the app. The per-entity `renderable_track_count`/`certified_finding_count` columns are the close-second keystone, retiring all of shape (B) in one stroke (web hub + API + MCP + sitemap + bio worklists + the search entity gate). Important nuance for sequencing: the rank-sweep walls are ALSO substantially retired by the Wave-1 pure hoists alone (short-circuit countStale off batch-fullness, gate computeCatalogueCounts to the drain-end branch with a per-tick bucket delta, compute readArchiveAffinity once per call) — those remove 7-of-8 full scans per tick with zero schema change and zero dependence on Turso's (absent) planner stats, so Wave 1 buys the biggest immediate relief while the Wave-2 is_catalogue flag makes the residual scan and every on-demand consumer seek-fast and future-proof.

## Wave 1 — cheap & safe now (pure hoists, projection trims, config, and candidate indexes; ranked by impact × certainty)

**1. Rank sweep: short-circuit countStale off batch-fullness**
`tier=hoist · tracks · T3, T2, T1`

- loc: apps/web/src/lib/server/catalogue.ts:1580 (countStale, consumed :1570/:1175)
- shape: Full anti-join COUNT over the whole catalogue on EVERY rankCatalogue call to produce the `remaining` drain signal (~19s prod, up to 8×/tick).
- impact: HUGE — removes ~19s from every normal rank call + the idle tick; planner-independent.
- fix: Delete the query on the common path: a FULL candidate batch (candidates.length >= limit) means more rows are stale by construction → return a >0 sentinel without counting; a SHORT batch means the stale set was fully consumed → remaining=0. Keep real countStale only for the limit===0 guard.

**2. Rank sweep: gate computeCatalogueCounts to the idle branch + apply a per-tick bucket delta**
`tier=hoist · tracks · T2, T3, T8, T1`

- loc: apps/web/src/lib/server/catalogue.ts:1779 (computeCatalogueCounts) via refreshCatalogueSummary:1828 / persistCatalogueCaches:1561/2162
- shape: Six-bucket conditional aggregate over the catalogue anti-join, actually run once PER CALL (up to 8×/tick ≈112s/tick) plus every idle tick — despite the module header claiming one-per-tick.
- impact: HUGE — planner-independent; the single largest per-tick reduction.
- fix: Gate the full recompute to the idle/empty-batch branch only (drain-end, line 1162); during an active batch apply an aggregate bucket DELTA from the rows the tick moved (extend the existing per-row withSummaryDelta to a batch delta). Removes 7 of 8 full scans/tick + the pointless idle recompute.

**3. Crawl tick: stop calling getCrawlStatus + split frontierByKind out**
`tier=hoist · tracks (anti-join to findings); crawl_frontier · T3, T1, T8, T2, T9`

- loc: apps/web/src/lib/server/crawl.ts:1326 (crawlCatalogue) + :1259 (dryRun), apps/web/src/lib/server/crawl.ts:1348 (getFrontierCounts)
- shape: Every 10-min crawl pass ends with getCrawlStatus() but reads only frontier.pending — paying a full catalogue anti-join count (~2-8s) + the un-indexed `group by kind` scan of ~90k crawl_frontier rows, 144×/day, for numbers no caller uses.
- impact: HUGE — the single biggest needless RECURRING scan (144×/day); the drop is planner-independent.
- fix: Replace the getCrawlStatus() call in crawlCatalogue with `select count(*) from crawl_frontier where state='pending'` (rides crawl_frontier_pick_idx). Split frontierByKind out of getFrontierCounts so only the on-demand admin `catalogue status` computes the by-kind breakdown; the crawl pass + funnel snapshot take state-only counts.

**4. Rank sweep: compute readArchiveAffinity once per call**
`tier=hoist · tracks (joined to track_artists) · T8, T2`

- loc: apps/web/src/lib/server/catalogue.ts:742 (readArchiveAffinity), called :1276 + :2084
- shape: The weighted qualified-artist GROUP BY over every track on an enabled label runs TWICE per call (pre-audio ladder + display-cache refresh), up to 16×/tick.
- impact: HIGH — planner-independent 2×→1× (and up to 16→1/drain with #2).
- fix: Compute the affinity once per call and pass it into refreshArchiveAffinityCache(affinity) instead of re-reading. Combined with rank #2 (gate cache refresh to idle), collapses to one affinity read per drain.

**5. Funnel: fold gatherLiveFunnel's three full scans into one conditional-aggregate pass** · **needs hosted proof**
`tier=hoist · tracks (left join findings) · T8, T1, T3, T2`

- loc: apps/web/src/lib/server/funnel.ts:239-269 (gatherLiveFunnel); scans :244, :191, :316
- shape: Three independent full scans of tracks⋈findings fired in one Promise.all (stage 7-col aggregate + anchor-split 4-col + anchor-backoff count) — same join, same table, 3× peak load.
- impact: HIGH — 3×→1× on daily snapshot + every refresh-live; removes the parallel peak-load spike.
- fix: Fold into ONE conditional-aggregate pass: keep the 7 stage SUM(CASE) columns, add the 4 anchor-split SUM(CASE WHEN <kindClause> …) columns and the backoff SUM(CASE WHEN <backoff predicate> …); the extra cutoff binds just append. Same numbers by construction, one scan.

**6. Demand nightly batch: PK-lookup promotions + `=0` partial-index clear** · **needs hosted proof**
`tier=cheap · crawl_frontier · T1, T5, T9`

- loc: apps/web/src/lib/server/demand.ts:310 (CLEAR), apps/web/src/lib/server/demand.ts:336 (per-artist promotion, loop :333)
- shape: Inside the write-locked nightly batch: a full ~90k-row UPDATE (`demand_rank<>1`) + one full pending-partition scan (~90k) per demanded artist MBID.
- impact: HIGH — relieves the nightly write lock (the `database is locked` failure class); the promotion half is planner-independent.
- fix: Promotion → PK point lookup: the frontier id is deterministic `musicbrainz:artist:<mbid>`, so `update … where id=? and state='pending'` (O(1), planner-independent). Clear → rewrite `<>1` to `=0` (demand_rank is only {0,1}) and add partial index `crawl_frontier(state) where demand_rank=0` so the predicate matches and seeks exactly the promoted rows.

**7. Fresh feed: swap the fat TRACK_SELECT for LEAN_TRACK_SELECT**
`tier=cheap · findings · T4`

- loc: apps/web/src/lib/server/fresh.ts:202 (listFreshReleases lit half)
- shape: 60 public list rows each carry 12 correlated subqueries + 3 heavy JSON columns (observation_alignment_json word-timing array, features_json, video_model_reasoning) the /fresh list never renders — the exact over-fetch LEAN_TRACK_SELECT was built to kill (Finding B4).
- impact: HIGH certainty — trims SSR HTML + hydration payload; safe drift-proof win.
- fix: Export LEAN_TRACK_SELECT from tracks.ts and swap the findings half; toTrackListItem already tolerates the undefined heavy fields. Deterministic, planner-independent.

**8. findSeedTrack: split the cross-table OR into two indexed seeks** · **needs hosted proof**
`tier=cheap · tracks (+ findings) · T1`

- loc: apps/web/src/lib/server/recommendations.ts:250 (findSeedTrack)
- shape: `… where tracks.track_id=? or findings.log_id=?` over a LEFT JOIN — the OR rejects no NULLs so neither index drives it → full 48k scan on every seed add/remove.
- impact: HIGH certainty, small blast radius.
- fix: Split: `select track_id from tracks where track_id=?` (PK seek), and only on a miss `select track_id,log_id from findings where log_id=?` (unique-index seek). Each becomes a single-row seek.

**9. Crawl status count via count(tracks) − count(findings)** · **needs hosted proof**
`tier=cheap · tracks (anti-join to findings) · T3, T1`

- loc: apps/web/src/lib/server/crawl.ts:1376 (getCrawlStatus catalogueTracks count)
- shape: `count(*) from tracks where not exists (select 1 from findings …)` — per-row PK probe, ~2-8s on the on-demand admin `catalogue status` read (the hot-tick caller is removed by rank #3).
- impact: MEDIUM — on-demand read, but a growing status command.
- fix: findings is a strict 1:1 subtype of tracks on the shared PK, so the catalogue count IS `count(tracks) − count(findings)` — two plain counts (findings is small; tracks count rides the smallest covering index) beat the anti-join probe. Superseded outright once the is_catalogue flag lands (W2).

**10. compileFilters: sargable year-range rewrite (substr → range)** · **needs hosted proof**
`tier=cheap · tracks · T1, T9`

- loc: apps/web/src/lib/server/search.ts:678-690 (year), apps/web/src/lib/server/tracks-hub.ts:171 → search.ts compile
- shape: `substr(tracks.release_date,1,4) >= ? / <= ?` wraps the column and defeats tracks_release_date_idx → full scan per year filter / year-lane (a common tier-4 shape).
- impact: HIGH — /search + the year fast-lane both benefit; near planner-independent.
- fix: Emit a bare lexicographic range `tracks.release_date >= 'YYYY' and tracks.release_date < 'YYYY+1'` (valid on YYYY-MM-DD) so the bound rides tracks_release_date_idx. Planner-independent (uses an index that already exists). The label/album/key/artist clauses in the same function are the Wave-3 design item.

**11. artists.name NOCASE index (kill the per-/label-render automatic-index build)** · **needs hosted proof**
`tier=cheap · artists · T9, T1, T2`

- loc: apps/web/src/lib/server/catalogue-groups.ts:469-474 (artist_slugs CTE join :472)
- shape: listLabelCatalogue folds credited names via `join artists a on a.name = lc.name collate nocase`; the only artists.name index is BINARY, so SQLite builds a per-request AUTOMATIC COVERING INDEX over ALL of artists on EVERY /label/<slug> render — cost O(artists), independent of label size.
- impact: HIGH — every label page currently scales with total artist count, not label size.
- fix: Add a NOCASE-collated index `artists_name_nocase_idx on artists (name collate nocase)` via db:generate; keep the BINARY index for other callers; keep the nocase fold. A matching-collation index suppresses SQLite's automatic-index path without needing planner stats.

**12. Analyze worklist: partial index mirroring tracks_embed_queue_idx** · **needs hosted proof**
`tier=cheap · tracks · T1, T9, T2`

- loc: apps/web/src/lib/server/track-work.ts:385-392 (kindClause analyze) + countTrackWork:566-572; funnel.ts:264
- shape: `source_audio_key is not null and (analyzed_at is null or analyzed_from is null or analyzed_from<>'full')` has NO covering index (embed has one) → scans captured rows every enrich tick + once/day in the funnel.
- impact: HIGH certainty — matches the ratified embed-queue precedent.
- fix: Add `tracks_analyze_queue_idx on tracks(track_id) where source_audio_key is not null and (analyzed_from is null or analyzed_from<>'full')` (optionally + capture_status<>'wrong-audio'). Bounds both the page-read and the funnel count to the analyze backlog. Also makes the funnel analyze(catalogue) count (#15) an index count.

**13. Catalogue Apple-URL worklist: partial index + drop coalesce() from ORDER BY** · **needs hosted proof**
`tier=cheap · tracks · T1, T3, T6, T9`

- loc: apps/web/src/lib/server/backfill.ts:1001 (listCatalogueAppleWork)
- shape: Full tracks scan + findings anti-join probe + filesort on `coalesce(capture_priority,0) desc` every catalogue-Apple tick; the eligible slice barely shrinks (a clean no-match re-enters after the 24h cooldown forever).
- impact: HIGH certainty — mirrors tracks_capture_priority_track_id_idx.
- fix: Add partial index `on tracks(capture_priority, track_id) where apple_music_url is null and backfill_apple_music_done_at is null and isrc is not null` (trim() stays a cheap residual), and drop coalesce — `order by capture_priority desc, track_id` sorts NULLs last (identical when every tier ≥0) so the index serves the order. Anti-join stays a cheap PK probe once the set is index-narrowed.

**14. Capture terminal-status lenses: partial index on capture_status** · **needs hosted proof**
`tier=cheap · tracks · T9, T1, T6`

- loc: apps/web/src/lib/server/catalogue.ts:2253-2279 (quarantine/unmatched/failed lenses), apps/web/src/lib/server/catalogue.ts:2583-2600 (requeueUnmatchedCaptures)
- shape: `capture_status in ('wrong-audio','unmatched','failed')` is unindexed → each admin lens load is a full anti-join scan; quarantine also sorts on unindexed catalogue_ranked_at.
- impact: MEDIUM-HIGH — admin lens loads; scan-to-result ratio worsens as terminal rows stay a tiny fraction.
- fix: Partial index `on tracks(capture_status, catalogue_ranked_at) where capture_status in ('wrong-audio','unmatched','failed')` — the partial predicate keeps it tiny (rare slice of a growing table, the tracks_dismissed_idx shape) and serves both the `=status` seek and the quarantine ORDER BY.

**15. tracks(label_id, release_date) composite index (label cover subquery + per-label fresh feed)** · **needs hosted proof**
`tier=cheap · tracks · T5, T9, T6, T3`

- loc: apps/web/src/lib/server/labels.ts:492 (LABEL_CATALOGUE_COVER_JSON), used :883/:598, apps/web/src/lib/server/fresh-entity.ts:103-115 (unlit label branch)
- shape: Both seek `label_id` via tracks_label_id_idx then SORT by release_date (no composite index) — the cover `limit 1` sorts a big imprint's rows per tile; the fresh feed fetches a mega-label's ENTIRE all-time subset then post-filters the 30-day window + temp-sorts (limit bounds only output, not the scan/sort).
- impact: MEDIUM — decouples label-page + per-label-feed cost from label size.
- fix: Add ONE composite index `tracks(label_id, release_date [, track_id])` via db:generate — serves both: the cover becomes an index seek, and the fresh query becomes seek(label_id)+ordered-range(release_date) so the window AND the limit both bound the scan/sort. Plain-ASC columns (avoid the desc() snapshot trap).

**16. rearmSeedLabels: partial index over the label-node slice** · **needs hosted proof**
`tier=cheap · crawl_frontier · T1, T6, T9`

- loc: apps/web/src/lib/server/crawl.ts:547-562 (rearmSeedLabels)
- shape: pick_idx seeks state='done' but residual-scans EVERY done row (the dominant ~90k partition once the graph drains) for kind/source/done_at to find tens of label nodes, then temp-sorts by done_at — every 10-min tick.
- impact: MEDIUM — recurring (every crawl tick).
- fix: Partial index `crawl_frontier(state, done_at) where kind='label' and source='musicbrainz'` → the pick becomes a seek over the tens of label nodes, done_at already ordered (no sort). `label_slug in (enabled)` stays a cheap residual. Plain-ASC.

**17. Artist review queue: (reviewed_at, created_at) index + bounded head walk** · **needs hosted proof**
`tier=cheap · artist_socials · T2, T6`

- loc: apps/web/src/lib/server/artists.ts:1659 (listArtistReviewRows)
- shape: GROUP BY artist + min(created_at) + ORDER BY the aggregate over ALL unreviewed socials before LIMIT 25 — every resolver-minted link is born reviewed_at NULL and stays, so the unreviewed set grows with every crawl-resolved artist.
- impact: MEDIUM — attention-queue read; high certainty on the bound.
- fix: Add composite `(reviewed_at, created_at)` index; select the oldest-N DISTINCT artist_ids from the null-reviewed group via a bounded index walk, then aggregate only those ≤25 artists — the aggregation stops growing with the archive. (Wave-2 fallback: a maintained unreviewed-artists worklist the resolver writes into.)

**18. artist_socials candidate queue: partial index on status='candidate'** · **needs hosted proof**
`tier=cheap · artist_socials · T9`

- loc: apps/web/src/lib/server/artists.ts:1235 (listArtistSocialsQueue default path)
- shape: `select distinct artist_id from artist_socials where status='candidate' limit ?` — status is unindexed; candidates are rare, so it scans most of the growing table to accumulate `limit` distinct ids. (The `fresh` path is fine — reviewed_at is indexed.)
- impact: MEDIUM.
- fix: Partial index `on artist_socials(artist_id) where status='candidate'` (a small, shrinking slice) so the distinct-artist read is a seek.

**19. Ear lens: partial index skipping the near-1.0 duplicate prefix** · **needs hosted proof**
`tier=cheap · tracks · T4, T1`

- loc: apps/web/src/lib/server/catalogue.ts:2242-2251 (ear lens) + :2229 (fetchLimit)
- shape: Walks tracks_nearest_finding_score_idx DESC but `duplicate_of_track_id is null` + the anti-join are residuals; deterministic duplicates score ~1.0 and cluster at the index head, so the walk reads the whole growing duplicate prefix (each a PK anti-join + residual) before yielding real discoveries.
- impact: LOW confidence — verify the planner uses it hosted; last in wave.
- fix: Partial index `on tracks(nearest_finding_score) where duplicate_of_track_id is null and nearest_finding_score is not null` so the DESC walk skips the duplicate head and stops within ~page rows; the diversity over-fetch then reads only genuine candidates.

## Wave 2 — denormalizations (stored/maintained columns; ranked by blast radius × certainty)

**1. KEYSTONE — per-track `is_catalogue`/`certified` flag + partial index (materialize the catalogue anti-join)** · **needs hosted proof**
`tier=denormalize · tracks · T3, T1`

- loc: apps/web/src/lib/server/catalogue.ts:967/1133/1578/1777 (rank-sweep anti-joins), apps/web/src/lib/server/crawl.ts:1376 (status count), apps/web/src/lib/server/funnel.ts (catalogue counts), apps/web/src/lib/server/search.ts:402 (entity gate join)
- shape: The single most-repeated shape: `tracks LEFT JOIN findings WHERE findings.track_id IS NULL` (≡ `not exists (select 1 from findings …)`) has NO materialized discriminator, so every consumer full-scans the growing tracks table with a per-row findings probe.
- impact: KEYSTONE — kills the largest share of the systemic root; ~15 findings touch this shape.
- fix: Add a maintained `is_catalogue` (or `certified`) boolean on tracks, written at certify/publish/dismiss/duplicate-mark time, with a partial index. `WHERE findings.track_id IS NULL` becomes `WHERE is_catalogue` — an index seek instead of a full left-join scan — retiring the residual rank-sweep scan (after the Wave-1 hoists), the crawl status count, the funnel catalogue anti-joins, the search entity gate, and the Apple/fresh feed anti-joins in one column. The ratified escape from the anti-join; do NOT add a vector index (owned/forbidden).

**2. KEYSTONE — per-entity renderable_track_count + certified_finding_count on labels/albums/artists (kill the hub group-by)** · **needs hosted proof**
`tier=denormalize · tracks (labels/albums hubs); track_artists (artists hub, ~2× tracks) · T2, T1, T3, T6`

- loc: apps/web/src/lib/server/labels.ts:795/824 (listHubPage) + :979 (listCatalogueBrowsePage), apps/web/src/lib/server/labels.ts:1217 / albums.ts:491 / artists.ts:541 (API list ops + MCP browse), apps/web/src/lib/server/labels.ts:588 / albums.ts:378 / artists.ts:341 (sitemap rows), sitemap-data.ts:134, apps/web/src/lib/server/search.ts:388-411 (entity hub gate), apps/web/src/lib/server/labels.ts:1567 (…MissingBio worklists ×3)
- shape: `entity ⋈ tracks left join findings group by entity having (sum(certified)>0 or renderable>=floor)` — an O(tracks)/O(track_artists) grouped scan re-run on EVERY hub ?page=N (uncached on the API/MCP path), every sitemap request, the search entity gate (uncorrelated IN(GROUP BY) → materialized once per exec, up to 4-6× per search), and the bio worklists (per-row correlated subqueries).
- impact: KEYSTONE — retires the entire catalogue-scale entity-list family in one stroke.
- fix: Denormalize maintained `renderable_track_count` + `certified_finding_count` (or a `certified` bool) onto labels/albums/artists rows, written by the edge-moving paths (publish stamps label_id/album_id/track_artists; crawl link; dismiss; duplicate-mark; merge) + a one-time backfill. The gate then filters/orders the small entity table by stored columns — no tracks join, no group-by, slug-orderable, pager offsets over the entity table alone. Shared HUB_INCLUSION_HAVING/HUB_RENDERABLE fragments mean one column set fixes web hub + API + MCP + sitemap + bio + the search gate at once. hubFindingCountsBySlug / hubCountsBySlug stay as bounded slug-in reads.

**3. Rank sweep: match_key + needs_rank tracks columns** · **needs hosted proof**
`tier=denormalize · tracks · T3, T1, T4`

- loc: apps/web/src/lib/server/catalogue.ts:968 (readCatalogueIdentity, match_key), apps/web/src/lib/server/catalogue.ts:1133 (candidateResult, needs_rank)
- shape: readCatalogueIdentity builds a full-catalogue byMatchKey duplicate map by scanning all captured rows (~31s); candidateResult's `catalogue_rank_corpus <> ?` predicate can never ride a btree, so the idle/near-drained tick full-scans the PK to return empty, dragging the inline embedding_blob.
- impact: HIGH — retires the ~31s identity scan and makes idle ticks free.
- fix: Two maintained columns: (a) `match_key` text (mirror of matchKey(), written on every mint/update) + index → duplicate resolution becomes per-candidate indexed equality seeks over the batch instead of a full-catalogue map (the ISRC half already has tracks_isrc_idx). (b) `needs_rank` boolean (set when corpus/vector changes, cleared when stamped) + partial index `where needs_rank` → the stale fetch seeks exactly the stale set and the idle tick costs O(0). Pairs with the is_catalogue keystone.

**4. Anchor worklist: has_embedding column + partial index** · **needs hosted proof**
`tier=denormalize · tracks · T1, T6`

- loc: apps/web/src/lib/server/track-work.ts:244 (ANCHOR_ORDER), listTrackWork:434
- shape: ANCHOR_ORDER leads with `(embedding_blob is not null) desc` — a raw expression that can't be a btree leading key — so the hourly anchor sweep materialises the whole un-anchored set (bulk of ~48k→150k, shrinks only as metered Apify anchoring catches up), table-probes each row for blob null-ness, sorts, returns 200.
- impact: HIGH — hourly, and the backlog grows with the catalogue.
- fix: Add `has_embedding` INTEGER (0/1) maintained wherever embedding_blob is written/cleared (embed write + wrong-audio quarantine); add partial index `(has_embedding desc, nearest_finding_score desc) where spotify_uri is null` and rewrite ANCHOR_ORDER to `has_embedding desc, nearest_finding_score desc nulls last, track_id asc` so the partial-index walk satisfies the ORDER BY prefix and LIMIT short-circuits at 200.

**5. tracks-hub year lane: maintained year→renderable-count rollup** · **needs hosted proof**
`tier=denormalize · tracks · T2`

- loc: apps/web/src/lib/server/tracks-hub.ts:587 (tracksHubYearLaneQuery)
- shape: `group by substr(release_date,1,4)` reads all ~48k→150k index entries per cold 60s window (non-sargable group key) — always rendered unfiltered.
- impact: MEDIUM.
- fix: Maintain a tiny `year → renderable count` rollup (refreshed on certification/write or the nightly cron) and read it for the unfiltered lane instead of grouping the whole table; keep the 60s TTL memo for the rarer filtered variants.

**6. Capture worklist: `capturable` flag (open-budget catalogue capture)** · **needs hosted proof**
`tier=denormalize · tracks · T1, T3, T6`

- loc: apps/web/src/lib/server/track-work.ts:328-372 (capture kindClause), apps/web/src/lib/server/funnel.ts:264 (capture catalogue count)
- shape: When the capture budget is OPEN, `capture_status is null` (crawler-minted rows carry no status) is non-selective and the finding∨catalogue OR + certified-first ORDER BY aren't index-served → full scan+sort per capture tick.
- impact: MEDIUM — only bites once the operator opens catalogue capture.
- fix: Maintain a `capturable` flag / partial index so capture_status stops being an unindexed leading predicate, and pair with the is_catalogue keystone for the catalogue arm. Note: overlaps the Wave-3 capture split-OR design; the flag is the denormalize path, the isolate-merge is the design path — decide together. Default-shut brake stays (keeps the common case cheap today).

## Wave 3 — design calls (need a decision / larger refactor; ranked by impact)

**1. Recommendations: per-user cache off the request hot path (non-vector half)**
`tier=design · tracks (+ findings anti-join) · T1, T3, T7`

- loc: apps/web/src/lib/server/recommendations.ts:107 (REC_ELIGIBLE_WHERE) + :514 (catalogueScan)
- shape: The per-user catalogue scan filters candidates by an anti-join + predicates with NO partial index over the eligible slice, then drags every survivor's 4KB embedding_blob through vector_distance_cos; candidate count is unbounded. The file's own tripwire: ~360 eligible today, but 'when it crosses ~5-10k this scan is seconds again.'
- impact: HIGH — /recommendations hot path; the file's declared scale wall.
- fix: Per-user cache keyed by (seed set, corpus fingerprint) — the rank_catalogue self-healing precompute shape the file names as the exit — so the engine leaves the request hot path; and/or a partial index over the rec-eligible slice to bound the anti-join. The vector_distance_cos math is vector-rfc's SIMD sidecar (owned); the candidate-set materialization/caching + anti-join pre-filter are the unowned half here.

**2. Search compileFilters: resolve name filters to indexed ids + key canonicalization** · **needs hosted proof**
`tier=design · tracks · T1, T9`

- loc: apps/web/src/lib/server/search.ts:645-648 (artist LIKE), apps/web/src/lib/server/search.ts:651-656 (label/album lower()) + :659-668 (key lower()), runFilters:712 + rankTracksByVector:838 pre-filter
- shape: The artist filter is `lower(artists_json) like '%'||?||'%'` — a leading-wildcard LIKE over unindexed JSON → full 48k→150k scan on the SINGLE most common search shape (every exactly-named artist). label/album `lower(tracks.label/album)=?` and `lower(tracks.key) in (…)` wrap columns and defeat the btrees that exist.
- impact: HIGH — the hottest, most common search shape.
- fix: artist: resolveEntity already holds artists.id → filter `tracks.track_id in (select track_id from track_artists where artist_id=?)` (track_artists_artist_id_idx); tier-4 LLM path resolves the emitted name to an id first, substring only as fallback. label/album: filter the resolved `tracks.label_id`/`album_id` (indexed) instead of the raw string. key: store a canonical/lowercased key form and index it (verify hosted). Requires threading ids through compileFilters — a design change. (The year clause is the Wave-1 cheap rewrite.)

**3. tracks-hub numbered pager: keyset/seek pagination for the deep tail** · **needs hosted proof**
`tier=design · tracks · T6, T1`

- loc: apps/web/src/lib/server/tracks-hub.ts:445 (tracksHubIdPageQuery), executed :507
- shape: Numbered ?page=N via OFFSET over the whole archive: 48k→~1000 pages now, 150k→~3100 pages; a crawler following the pager to the tail walks up to ~144k index entries per request (O(offset)). The hosted ship-bench only proved 25k / offset ~20k unfiltered — 150k tails + a non-sargable filter were never proven.
- impact: MEDIUM-HIGH — the crawler-facing pagination scale wall.
- fix: Give the crawl-facing deep tail keyset/seek pagination: a cursor on (release_date, track_id) with `where (release_date, track_id) < (?, ?)` rides tracks_release_date_idx with zero offset walk; or cap max reachable ?page and route the tail through year-lane jumps + filters. If numbered OFFSET is kept as a deliberate choice, re-prove at 150k WITH a non-sargable filter active.

**4. Capture worklist: split the finding∨catalogue OR into two ordered streams merged in the isolate** · **needs hosted proof**
`tier=design · tracks · T1, T6, T3`

- loc: apps/web/src/lib/server/track-work.ts:328-372 (capture) + :434 (listTrackWork) + countTrackWork:566
- shape: Open-budget capture: one query must serve a two-branch OR (findings arm ∨ catalogue arm) plus a certified-first ORDER BY prefix `(f.track_id is not null) desc` that isn't index-served → full scan+sort per tick. countTrackWork is a full scan (the module admits capture/analyze counts scan).
- impact: MEDIUM — gated behind operator opening catalogue capture.
- fix: Keep the default-shut brake. For open-budget: drive the findings arm from `findings` (PK join) and the catalogue arm from tracks_capture_priority_track_id_idx (partial, walking capture_priority desc), filter capture_status/duration/dismissed as residuals, and INTERLEAVE the two ordered streams (findings first) in TS instead of one ORDER BY the planner must sort. Pairs with the Wave-2 capturable flag — decide flag-vs-merge together.

## Owned elsewhere — do NOT touch

- already-fixed — catalogue.ts:1183 rankCatalogue max-similarity vector cross-scan (finding_vec/candidate_vec CTEs) + the RANK_BATCH_SIZE=250 batch write. CONFIRMED mitigated: both CTE arms carry `as materialized`, the join is a `cross join` pinning findings (small) as the driver with the `embedding_blob is not null` guards moved inside the CTEs, and the batch write is bounded/single-row/PK-keyed/idempotent under the single-writer box sweep. Do NOT re-flag as new.
- artist-session — backfill-artist-images.ts:55 listWork (`select … from artists where image_url is null and spotify_artist_id is not null order by id limit ?`): the avatar-fill worklist scans artists on the unindexed `image_url is null`. Owned by the artist edges/credits/visibility session; shape noted only.
- vector-rfc — the vector_distance_cos math in recommendations.ts listRecommendations catalogueScan (recommendations.ts:514) and any getSimilarFindings / list_similar_tracks / sonic-search / similarity ranking. The in-memory SIMD sidecar owns ALL vector distance. Only the NON-vector shape around it — the REC_ELIGIBLE_WHERE anti-join pre-filter and the per-user candidate-set cache — is in this backlog (Wave 3-1). Do not touch the distance computation.

## Guardrail (so this can't re-accrue)

Two concrete, complementary mechanisms so this debt can't silently re-accrue. (A) A BUILD-FAIL vitest, new file `apps/web/src/lib/server/db-query-shape.test.ts`, modeled 1:1 on the existing `apps/web/src/lib/server/orpc-coverage.test.ts` and already executed by `bun run test` inside `deploy:gate` (package.json:54 → `format:check && lint && typecheck && test && test:scripts`), so a violation aborts the Cloudflare deploy build the same way an uncovered oRPC route does. It statically scans the server SQL surface (`apps/web/src/lib/server/**`, `apps/web/src/db/**`) for the forbidden shapes on the four growing tables (tracks, crawl_frontier, track_artists, findings-as-anti-join) and fails on any NEW occurrence not on an explicit, SHRINKING allowlist — exactly the PENDING-list enforcement the oRPC coverage tests use (an entry must map to a real occurrence; the list must shrink as Wave 1/2/3 land). Flagged shapes: the unmaterialized catalogue anti-join (`findings.track_id IS NULL` or `not exists (select 1 from findings …)` without an accompanying `is_catalogue`/`certified` predicate), function-wrapped filter columns that defeat btrees (`lower(tracks.`, `substr(tracks.release_date`, `like '%' ||` over tracks/track_artists), an `OFFSET` bind on the tracks-hub pager, `select *` / the fat TRACK_SELECT on a public list read, `create index … libsql_vector_idx` against a populated table, and a query vector bound as text rather than blob (the docs/local-database.md traps). Couple it to a hosted-proof gate: any allowlisted `needsHostedProof` index must be validated against a scratch hosted-Turso DB via the existing `apps/web/scripts/bench-tracks-hub.ts` pattern (never local-green) before the allowlist entry is removed. (B) Add a `db-query-shape` domain to the nightly self-audit rotation: append `"db-query-shape"` to the `DOMAINS` array in `docs/agents/hermes/scripts/audit/rotation.ts` (7→8; the file documents the exact three-step add — key + `prompts/<key>.md` + `DOMAIN_META` entry), author `docs/agents/hermes/scripts/audit/prompts/db-query-shape.md` from this spec's T1–T9 taxonomy + the four growing tables + the hosted-Turso reality rails + the vector-rfc/artist-session ownership boundaries, and reflect the new domain in `packages/skills/fluncle-audit-operator/SKILL.md` and `docs/agents/hermes/audit-timer/README.md`. The audit catches the SEMANTIC recompute-by-scan a grep can't (a new O(tracks) group-by reached through a helper, an anti-join via a view, a per-row correlated subquery in a loop) and either fixes it on green CI or files it to `docs/audit-backlog.md`. Together: the test is the hard gate (a new unguarded growing-table scan fails the deploy), the audit domain is the recurring deep sweep (judgment shapes + hosted-proof follow-through).
