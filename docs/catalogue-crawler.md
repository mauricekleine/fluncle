# The catalogue crawler

Fluncle's acquisition of **metadata**, and nothing else. The crawler is a **probe**: it charts, it measures, it never speaks. Nothing it brings back is a finding.

The crawler walks the MusicBrainz release graph outward from the record labels the operator has **enabled** and writes catalogue rows into `tracks`. A catalogue track is a `tracks` row with **no `findings` row** — that is the entire definition, and it is what the crawler can and cannot do, expressed as a schema rather than as a rule (see [track-lifecycle.md](./track-lifecycle.md) for the tracks/findings split).

It cannot certify anything, because a crawler has no ears. It captures no audio. It writes no note, no video, no observation, no Log ID. It just brings back names.

**It is one half of the catalogue domain.** The crawler makes the rows exist; [The Ear](./the-ear.md) makes the pile useful — `/admin/catalogue`, ranked by how close each row sits to a finding the operator already loves. They share a table, a CLI group (`fluncle admin catalogue`), an oRPC domain, and a loop: the `fluncle-crawl` cron writes rows every 10 minutes and the `fluncle-rank` cron ranks them every 30. Neither can certify anything.

## What it is for

The archive is ~60 findings — every one heard, judged, and coordinate-stamped by the operator. The catalogue is the rest of the sky: the tracks Fluncle's instruments can measure without him ever standing there. Dense enough, it becomes a retrieval space — the fuel behind "more like this", the `/mix` rail, and the operator's own dig. Sparse, it is nothing.

The crawler's job is to make it dense **without ever letting an uncertified track pass for a finding.**

## The boundary gate: enabled-label storage + graph-distance discovery

There is **no genre inference**. No MusicBrainz tag, no Discogs style, no BPM band, no classifier. That is ratified, and it is not an omission — it is the design.

The operator already drew the boundary when he ruled on the labels. Every label in the archive carries a `seed_state` (`enabled` / `disabled` / `undecided` — [label-entity.md](./label-entity.md)), and that column now answers two questions: **may the next crawl seed from this label, and may a release on this label be STORED?** Those are distinct, and the split is the whole of this section: **storage is enabled-label-only; the graph walk is a discovery mechanism** that ranges further out to find the next labels to rule on.

**Storage.** A release's tracks are written into `tracks` only when the label that pressed it is one the operator has `enabled`. The check is a single fold-match at the write chokepoint in `expandRelease` (`isEnabledLabel`, the same aggressive `labelFold` the rest of the crawler uses, against the archive spelling already resolved). A release on a non-enabled label stores **nothing** — no tracks, no album row, no `label_id`/`album_id`/artist edges — even when the walk reached it.

**Discovery.** The walk still ranges outward by graph distance, because that is how the crawler finds the next labels worth ruling on:

| hop   | what it is                                                    | stored?                                |
| ----- | ------------------------------------------------------------- | -------------------------------------- |
| **0** | a release on a label whose `seed_state` is `enabled`          | **yes** — the label is enabled         |
| **1** | an artist who appears on such a release                       | (a hop, not a release)                 |
| **2** | a release that artist **also** appears on                     | **only if its label is `enabled`** too |
| —     | **STOP.** `maxHop` (default 2, ceiling 3) ends the walk here. |                                        |

Hop distance bounds the **discovery**, never the **storage**. A hop-2 release on an enabled label **is** stored; a hop-0 seed release is stored because its seed label is enabled, not because it sits at hop 0. A hop-2 release on a reggae, jazz, or major label is walked for the labels it reveals and then its tracks are dropped on the floor. A node past the limit is never enqueued, so the walk **terminates by construction** rather than by a watchdog. Set `--max-hop 0` and the crawl never leaves the seed labels' own releases at all.

The one hard-coded exclusion is an identity, not a judgement: MusicBrainz's **"Various Artists"** placeholder is credited on every compilation ever pressed, so following it as a hop-1 artist would walk the crawler out of drum & bass and into the whole of recorded music in a single step.

### The widening loop — the crawler proposes, the operator rules

A label the walk **discovers** that nobody has ruled on enters as `undecided` (the `labels` DDL default) and surfaces as a row in the `/admin` attention queue. It is **not crawled.** The next crawl seeds from it only once the operator enables it.

That is how the boundary widens without ever leaving his hands: the crawl reaches an artist's other label, says "here is one I found," and stops. One keystroke at `/admin/labels` decides whether the next crawl stores it. Ruling on a label is OPERATOR tier (`update_label`); the crawl itself is agent tier. Enabling a label is what turns its releases from discovered-only into **stored**: an unruled or disabled label surfaces in the queue and its releases are walked for discovery, but nothing they carry is written until the operator enables it. Disabling a label touches nothing **already** stored — a ruling changes what the crawl stores going forward, never what it has kept.

A label the crawler discovers under a different spelling from one he has already ruled on does **not** re-enter the queue, **and the crawled track is written with the archive's spelling, not the vendor's.** The archive spells it `Medschool`; MusicBrainz spells it `Med School`. The fold collapses both to `medschool`, and the row is written as `Medschool`.

Write the archive's canonical label spelling onto crawled tracks. This preserves `slugify(tracks.label) = labels.slug`, keeping every capture-priority rung and the disabled-label veto active.

A genuinely new label is minted from MusicBrainz's spelling and the track carries that same spelling, so the two agree by construction there too.

## Why MusicBrainz carries the walk

| source          | role                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------ |
| **MusicBrainz** | **the graph AND the identity.** Label → releases → recordings (+ ISRCs) → artists → releases     |
| **Discogs**     | release/master ids, reached through MusicBrainz's curated `url-rels` — **zero API calls**        |
| **Spotify**     | the `spotify_uri`/`spotify_url` anchor, filled OFF the crawl by the box's Apify sweep. Optional. |

**MusicBrainz is the only recording-centric source of the three**, and a track-level catalogue needs exactly that. Its graph supports the hop model cleanly and completely: `/release?label=<mbid>` and `/release?artist=<mbid>` are paginated browse endpoints, and one `/release/<mbid>?inc=recordings+artist-credits+isrcs+labels+url-rels` brings back a release's whole tracklist — every recording MBID, its ISRCs, its artist credits, its length, its label, and the Discogs relation — in a single request. It is CC0 and needs no token.

Discogs IDs arrive through MusicBrainz's curated `url-rels`, with no Discogs API calls.

## The anchor: off the crawl entirely, onto a resolver waterfall (ListenBrainz → dark Spotify search → Apify fallback)

The crawler is MusicBrainz-only. Spotify anchoring runs asynchronously through the resolver waterfall: recover an ISRC when possible, try ListenBrainz, optionally use paced official Spotify search, then use Apify as the metered fallback.

0. **Deezer ISRC recovery.** For an ISRC-less row, search Deezer before anchoring. Accept a recovered ISRC only when artist set, base title, version descriptor, and duration within ±3 seconds pass server-side verification.

   Run Deezer search from the box because its quota is per source IP. The Worker builds the query, verifies supplied candidates, and performs the fill-empty-only ISRC write.

1. **The free rung — ListenBrainz (`resolve_anchor` → `resolveAnchorFree`).** ListenBrainz labs exposes a recording-MBID → Spotify-track-id mapping (`spotify-id-from-mbid`, no auth, no spend) built from the same open graph the crawl walks. A crawler-born row always carries its `mb_recording_id`, so the box POSTs just the row's `trackId` and the Worker: reads the MBID, asks ListenBrainz for the recording's Spotify ids, fetches the FIRST id's metadata with **one** `GET /v1/tracks/{id}` (a cheap by-id read — never a search), and runs that single candidate through the SAME gate below. A hit here costs nothing and the row never reaches Apify. The resolver preserves `no-map`, `empty-ids`, request failure, metadata failure, and gate rejection as separate outcomes; the sweep emits them as `lbNoMap`, `lbEmptyIds`, `lbRequestFailed`, `lbMetadataFailed`, and `lbGateRejected` rather than laundering every miss to one null. The measured 2026-07-30 baseline is 11 mapping rows and 4 non-empty Spotify-id lists across 20 real queued MBIDs: roughly 20% had a free candidate, while the realised conversion rate is whatever these counters report.
2. **The dark Spotify SEARCH rungs (slice 2 — `resolveAnchorFree` continues, `apps/web/src/lib/server/anchor-spotify-search.ts`).** On a ListenBrainz miss, and ONLY when the operator flag `anchor_spotify_search_enabled` is on (DEFAULT OFF) and the clock is outside the Friday-morning Frontier-refresh window, the Worker resolves the row against the OFFICIAL Spotify app's SEARCH: first `findSpotifyTrackByIsrc` (the exact ISRC key lookup, for a row that carries an ISRC), then `searchTrackCandidates` (the fuzzy fallback for a no-ISRC row or an ISRC miss). Each candidate runs the SAME gate. These are free in dollars but share the official app's rate budget with user-facing mints/publish — the app that starved under 429s at catalogue scale — so they ship **default-OFF behind the dark flag** (off ⇒ not one Spotify search request), skip the Friday peak, and the box paces them under a **60/min ceiling** (`resolve_anchor` returns `spotifySearchDone`, and the sweep holds consecutive search-bearing calls ≥2s apart); the existing 429/Retry-After backoff yields the token to a mint on the first sign of pressure. This is the ~75-85% Apify cost cut. Flip it on for the pilot with `set_anchor_search` (operator tier).

   **The circuit breaker (`apps/web/src/lib/server/spotify-anchor-breaker.ts`).** The flag and the Friday window are a switch and a schedule; the 429 backoff and the 60/min pacer are per-call and open-loop. None of them can see that Spotify has been pushing back for the last ten minutes, which is the state that decides whether these rungs should be running unattended at all. The breaker is that memory. `spotifyFetch` — the chokepoint EVERY Spotify call passes through — records each 429 into a durable count on the `settings` KV; **5 throttles inside a rolling 10 minutes** trip it, and while tripped `anchorSpotifySearchAllowed` returns false, so these rungs are skipped exactly as the dark flag skips them. It **releases itself after 1 hour** (one `fluncle-anchor` tick), so a trip costs the catalogue one tick and needs no operator. Two properties are load-bearing: 429s are recorded from **any** path (a mint's throttle pauses the optional anchor work too — the breaker protects the SHARED app, and this is the only caller on it whose work can wait), and the breaker gates **only** these rungs (`spotifyFetch` records into it and never consults it, so no mint, publish, or Frontier refresh is ever gated). It reads **default-deny** — unreadable state pauses the rungs. Inspect it with `get_spotify_anchor_breaker` (agent-allowed read), clear it early with `reset_spotify_anchor_breaker` (operator tier).

3. **The Apify fallback (`anchor_track`).** Only when EVERY rung above misses does the box spend the metered Apify search actor (which has its OWN Spotify budget): it runs the actor, groups the results by query, and POSTs each row's candidates to the agent-tier `anchor_track` op — and when Apify is down, the free rungs still anchor their share (graceful degradation).

Each tick the sweep reads the anchor worklist (`list_track_work` `kind: "anchor"`) with the box's agent token — each row carrying a ready-made `anchorQuery` (its artists + title) so the box never builds the query. Both rungs land in the SAME verification (`lib/server/anchor.ts`) — two gates, precision over recall — a wrong anchor poisons the telescope and the certify path, so a miss is always preferred to a wrong stamp:

1. **Exact ISRC.** The actor returns each candidate's `track_isrc`, so a row that carries an ISRC anchors to the candidate whose ISRC equals it (case-insensitive). If several candidates share the ISRC — a re-press under a second Spotify track id, seen live — the closest duration wins.
2. **The verified search triple** — the recall unlock, and the fallback for a no-ISRC row (or a row whose ISRC matched nothing). Most catalogue rows exist on Spotify under a _different_ release than the crawl walked (a festival compilation, a label sampler), so the recording's ISRC never appears in Spotify's index. A candidate anchors ONLY when it clears ALL THREE of a folded ARTIST-set match, a folded base-TITLE match, and a duration within **±3s** — all through the ratified `matchKey` fold (`track-match.ts`), which keeps a remix/VIP descriptor part of the identity, so the original of a logged VIP can never anchor to the VIP. Closest duration wins; if none clear it, no stamp.

Stamp `spotify_anchor_attempted_at` after every complete anchor attempt and back off for `ANCHOR_REASK_AFTER_DAYS`. Stop offering a row at `ANCHOR_MAX_ATTEMPTS`. A free-rung miss remains unstamped so the metered fallback can run.

When the normal gates miss, detect a suspected upstream version-label mismatch using equal or subset artist identity, matching base title, duration within `ANCHOR_SUBSET_DURATION_TOLERANCE_MS`, and a differing version descriptor. Record the candidate for operator review without anchoring it.

The review then surfaces as the `anchor-review` source on the `/admin` attention queue (`listAnchorReviewRows`, riding the tiny partial `tracks_anchor_review_idx` so the read never drags the catalogue's embedding blobs off the page), showing both titles side by side, the signed duration gap, and a link to the MusicBrainz recording so the metadata can be fixed AT THE SOURCE for every consumer of the open graph. The operator rules with **`resolve_anchor_review`** (`POST /admin/catalogue/anchor/reviews/{trackId}/resolve`, **OPERATOR tier**): `accepted` writes the anchor exactly as a verified hit does (uri + url, fill-empty-only cover + ISRC, the stamp and counter together, the artist edges off the same stored candidate), `dismissed` clears the note and leaves the row's normal retry lifecycle alone. Either ruling — and any anchor by any path — clears the review, so a note never outlives the miss it describes. **Nothing auto-anchors**, which is the whole point: this is the never-wrong-stamp rail holding while the evidence stops being thrown away. A candidate that carries no Spotify id (a Deezer-rung suspect, or one seeded by `apps/web/scripts/backfill-anchor-reviews.ts` for the rows that already hit the cap) rides the queue as information only — Accept is not offered, and the MusicBrainz fix is the action.

## The MusicBrainz identity layer (recording MBIDs)

Every track carries its **MusicBrainz recording MBID** in `tracks.mb_recording_id` — the one identifier that reconciles a track to the wider open music graph (MusicBrainz, Wikidata, and everything that keys off them). It is the canonical KG join key, and it is emitted on the `/log` page's `MusicRecording` as both a `sameAs` (`https://musicbrainz.org/recording/<mbid>`) and a KG `identifier` PropertyValue (`propertyID: "musicbrainz-recording-id"`) — only when present, the honest degrade. There are **three fill paths**, and two of them cost nothing:

1. **The crawler already knows it — it is the PK.** A crawled `track_id` is `mb_<recording-mbid>` by construction, so the MBID is literally the primary key minus its prefix. The crawler stamps `mb_recording_id` at mint time (the `crawl.ts` insert), so a crawled row is graph-joinable off the bat; and one idempotent SQL statement — `substr(track_id, 4)` into the column — backfills every pre-column row of history (`recording-mbids.ts`, the free prefix strip). No MusicBrainz call for either.
2. **Findings / Spotify-born rows resolve by ISRC.** A `track_id` that is a Spotify id (a certified finding published via a Spotify add) has no MBID in its PK. Those resolve through the **shared MusicBrainz client** (`/isrc/<isrc>` → its recordings, the first taken), 1 req/s, `Retry-After` honoured, circuit-broken on a throttle — the shipped `backfill_label_images` discipline, verbatim.

The whole thing is the agent-tier `backfill_recording_mbids` op (CLI `fluncle admin backfills recording-mbids`), driven by the on-box `fluncle-recording-mbids` sweep (docs/agents/hermes/recording-mbids-timer/, box enable operator-gated). Reliability is **the simple attempt stamp**: the ISRC drain stamps `mb_recording_id_attempted_at` on every terminal outcome — a hit (the MBID is written too) AND a miss (MusicBrainz has no recording for the ISRC) — so an unresolvable ISRC drains the worklist rather than being re-queried every tick forever. Only a throttle leaves the row untouched, so the next tick retries it fresh. The worklist rides the partial `tracks_mb_recording_id_queue_idx` (`mb_recording_id is null and mb_recording_id_attempted_at is null`), which SHRINKS as the backlog drains — never a scan of the growing catalogue. It writes catalogue identity only, never a certification, so it sits inside the same rail as the rest of the catalogue domain.

## Deterministic · resumable · polite · idempotent

**Deterministic.** Reserve half of each batch, rounded up, for release nodes whenever releases are pending. Fill the remainder with label and artist discovery nodes in breadth-first order so acquisition and discovery advance together.

**Resumable.** Every scrap of walk state lives in the `crawl_frontier` table, never in a process. A crawl is a **marathon the schedule finishes, not the process** — the neighbourhood of one seed label is hundreds of releases at one request per second. So "run again" and "resume" are the same command, and a box reboot mid-label costs one node, not one crawl. A paginated node (a label's or an artist's release list) stays `pending` with its browse cursor advanced, so a 900-release label drains across ticks instead of blowing one.

**Polite.** All MusicBrainz callers share `lib/server/musicbrainz.ts`, which serializes requests at approximately 1 req/s, identifies the client, honors `Retry-After`, and circuit-breaks an exhausted 503.

**Idempotent**, in two layers, because one is not enough:

1. A bounded pre-read over each batch's ISRCs and minted ids (`tracks_isrc_idx`). The ISRC is the recording's real identity, so a track Fluncle has already **certified** — whose `track_id` is a Spotify id, not an `mb_…` one — is recognised and skipped. Without this the crawler would quietly shadow a finding with an uncertified twin.
2. `on conflict (track_id) do nothing` on the insert, closing the race the pre-read cannot (two ticks, same recording) at the primary key.

A catalogue track's `track_id` is `mb_<musicbrainz-recording-id>` — deterministic, so re-crawling the same recording collides on the PK and writes nothing. **A re-crawl of the same graph writes zero new rows.**

## The seed re-arm (release freshness)

Enabled seed labels are recurring subscriptions. Each pass re-arms eligible MusicBrainz label nodes older than `REARM_AFTER_DAYS`, probes the tail, pages backward, and stops when a page adds no release nodes. `REARM_BATCH` bounds each pass.

## The freshness tap (day-one releases)

The seed re-arm closes the freshness gap **within MusicBrainz** — but MusicBrainz has a gap of its own: its editorial database lags a release by **~2 weeks**, because a volunteer has to enter it. So a Friday drop is not merely late through the crawl's own cadence; it does not **exist** in the source the crawl walks until well after the weekend it mattered. On `/fresh`, that reads as a hole.

MusicBrainz carries the complete graph; Spotify provides the bounded day-one freshness tap. Probe only enabled seed labels. Mint an album only when a known Spotify artist grounds it and the normalized copyright label exactly matches the seed. Fetch album and track records individually because batch endpoints are unavailable at the configured API tier.

- **No date, no mint.** An album carrying no `release_date` is dropped before either signal is weighed. `/fresh` selects on `release_date`, so a null-dated row is **invisible** there — it would pollute `tracks` with a permanently unreachable row while delivering exactly none of the day-one freshness the tap exists for. Minting it is a silent no-op, so it is never minted (`skippedUndated` is the tripwire if a vendor ever starts returning them).
- Route every tap call through the shared Spotify call meter and Retry-After handling. The tap uses only budget below its own ceiling, pauses cleanly on the ceiling or a 429, and resumes from its persisted reliability state.

**The dedupe contract** is the load-bearing design point, because now two acquirers mint an uncertified row for the same recording: the MB crawl (`mb_<recording-mbid>`) and this tap (`sp_<spotify-track-id>`). Whichever lands first, the other must fold onto it, not mint a twin. The strong keys are the **Spotify id / uri** and the **ISRC**. But a tap-first row can arrive with a **missing or divergent** ISRC — Spotify and MusicBrainz occasionally disagree — so a second, tighter fold closes that hole: an **exact title fold within the same album** ([`catalogue-dedupe.ts`](../apps/web/src/lib/server/catalogue-dedupe.ts)). Two pressings/paths of one recording share an album row (folded on the release-group MBID, or the album-title slug when the tap has no release group), so an equal album_id + an equal title fold is the same track. The fold is deliberately tight — exact, one album — so a VIP/remix (a different title) is never merged. `writeCatalogueTracks` (the MB side) and `writeLabelReleaseTracks` (the tap side) both carry the same layers, so the two converge from **either** direction. Because the tap sets `spotify_uri`, a tap-first row also converges with a **certified finding** for the same Spotify track (a bare-id PK) via that uri, never a duplicate anchor.

The timer calls the oRPC endpoint directly so its request shape is independent of the box's pinned CLI version.

## The certification rail

`llms.txt` asserts, truthfully, that _"every track in the archive is one he found, listened to, and certified."_ One crawled row leaking into a feed makes that sentence a lie. So the firewall is structural, and it is tested:

- The crawler contains **no `insert into findings`**. It cannot mint a coordinate.
- Every finding read drives through the `findings join tracks` inner join (`FINDINGS_FROM`), so `/log`, `/api/v1/tracks`, the RSS feed, the sitemap, the Galaxy game's star field, search and "more like this" are structurally blind to a crawled row — **including when it carries a perfect embedding.** You cannot fly to a waypoint that was never dropped.
- Every SPEAKING queue lives on `findings` (`enrichment_status`, `context_status`, the `backfill_*` columns) or joins through it, so a 10,000-row crawl enqueues **zero** enrich, note, observe or video jobs — those are certification concerns and stay blind to a crawled row. Capture is the one queue that now DOES reach a catalogue row (it is a measurement, on the catalogue-aware `list_track_work`), and there the thing standing between the crawl and the invoice is not a join but the **capture budget's default-deny brake**: it ships PAUSED, so the sweep narrows to the findings until the operator opens it (docs/gpu-batch-embed.md, docs/the-ear.md § The capture budget).

Crawl-minted labels, albums, and artists may render public graph pages from their tracklists. Sections render only when populated, and total renderable tracks determine indexability. Crawl-minted tracks remain uncertified and receive no coordinate or track page.

### What the crawl leaves `capture_status` as, and why that matters to someone else

The crawler writes `tracks` rows **without naming `capture_status` at all**, so the DDL default lands: **`'pending'`, with `source_audio_key` NULL, `source_audio_failures` 0, and `source_audio_attempted_at` NULL.** That is deliberate and it is the contract.

The capture queue reaches those rows — the `fluncle-capture` sweep reads the catalogue-aware `list_track_work` (`kind=capture`), which serves `tracks` outer-joined to the certification. What stands between a 10k crawl and 10k metered capture jobs is the **capture budget** — a default-deny kill switch plus a rolling-24h count/byte cap, consulted at the queue before the worklist is even selected. It ships PAUSED, so a fresh crawl's rows are invisible to the sweep until the operator deliberately opens the budget.

And `'pending'` is exactly the state the queue consumes, gated and ordered by The Ear's **`capture_priority` ladder** (`docs/the-ear.md`; RFC artist-primary-capture). Capture is **artist-driven**: a row is AUTHORIZED to spend only when a credited artist is qualified (identity, through the `track_artists` graph) or its label is `enabled` — everything else (an un-enabled label, a major, a lone crossover finding on a label) sinks to the `unauthorized` tier, metadata welcome and money withheld, and an operator-**disabled** label is vetoed outright (tier −1). Among the authorized rows the old ladder orders the spend (qualified-artist > label-with-a-finding hint > enabled-seed-label). All the negatives ride the same `capture_priority >= 0` SQL exclusion. So the crawl leaves every row in the honest "never attempted" state, carrying the label and artist metadata the ladder gates on, and lets the ladder decide who is worth buying audio for. **The crawler writes only that neutral state** — it never touches the budget or the priority; it just does not poison the well for the queue that drains it.

- **Audio acquisition is a separate, operator-gated pipeline and none of it lives in this repo.**

`findings-certification.integration.test.ts` proves all of it against the real schema — running the actual `/rss.xml` and `/sitemap.xml` handlers over a row the real crawler wrote, not a re-implementation of their SQL. `crawl.integration.test.ts` proves the walk itself: the hop limit, the dedupe, the idempotence, the label mint, the circuit breaker, the resume.

## Running it

```bash
fluncle admin catalogue crawl --dry-run          # the seed plan; writes nothing at all
fluncle admin catalogue crawl --limit 10         # one bounded pass
fluncle admin catalogue crawl --max-hop 0        # the seed labels' own releases only
fluncle admin catalogue status                   # the frontier, the catalogue's size, the seed set
```

In production it runs unattended as the on-box `fluncle-crawl` sweep — a `--no-agent` deterministic poller behind the server boundary, one bounded pass every 10 minutes. See [agents/hermes/crawl-timer/README.md](./agents/hermes/crawl-timer/README.md) (box activation is operator-gated).

## The shape of the frontier

One row of `crawl_frontier` is one node of the graph and one unit of work.

- `label` — hop 0. Two flavours, and the pair is what makes label resolution itself resumable: the **seed** (`source: 'fluncle'`, `external_id` = the operator's `labels.slug`) expands into the MusicBrainz **entity** (`source: 'musicbrainz'`, `external_id` = the MB label MBID), which expands into its releases. A label MusicBrainz does not know is `skipped` with a reason — recorded honestly, never retried forever.
- `release` — expands into the tracks it carries (the write) and the artists on them. In the same pass it stamps the graph edges INLINE: `tracks.label_id` (folded on the label slug), `track_artists` for any artist Fluncle has already certified, and — folded on the release's MusicBrainz **release-group MBID** (`inc=release-groups`, slug as the fallback) — the `albums` row and `tracks.album_id` pointer. The album edge is written off the bat now, not deferred to a deploy backfill; the one-off `scripts/backfill-album-graph.ts` only catches history up. See [album-entity.md](./album-entity.md#how-a-row-gets-minted).
- `artist` — expands into that artist's other releases.

Resolve seed labels by `mb_label_id` whenever present. For unresolved labels, accept a name search only when exactly one candidate matches the normalized fold; otherwise mark the node skipped with candidate MBIDs for operator identity ruling.

`id` is deterministic (`<source>:<kind>:<external_id>`), so re-discovering a node the walk already holds is an `on conflict do nothing`, not a second traversal — which is what keeps a graph full of cycles (two artists on one release each pointing back at it) from looping forever.

Reliability follows the shipped `backfill_*` convention verbatim: `attempted_at` / `attempts` / `failures` / `done_at`. A failed node backs off exponentially on its consecutive-failure count and is retried by a later tick; past 5 failures it stays `failed` and is never picked again. `parent_id` records the edge that discovered a node, so a bad subtree is traceable and prunable; `label_slug` carries the enabled seed the whole subtree descends from.

## Demand

The crawler decides WHAT the archive knows and, within the operator's rulings, The Ear guesses the order to capture it in. But that order is a machine's guess about taste — it has no idea which of those thousands of catalogue rows a real human came looking for. **Demand** closes that gap with the one signal the site already collects: Simple Analytics pageviews.

A nightly `--no-agent` sweep (`fluncle-demand`, [docs/agents/hermes/demand-timer/](./agents/hermes/demand-timer/)) fires the AGENT-tier `record_demand` op once. The **Worker** holds the Simple Analytics key (`SIMPLE_ANALYTICS_API_KEY`, a Worker secret) and does the fetch itself (`GET simpleanalytics.com/fluncle.com.json` — the APEX host; `www` 404s — with an `Api-Key` header) over the trailing 30 days; the box is a bare trigger holding no key. It keeps only the `/artist/<slug>` and `/label/<slug>` pageviews, resolves each slug to an entity (an unknown slug is skipped silently), and REWRITES two dedicated reorder columns:

- **`tracks.demand_score`** — for every track of a demanded artist (via `track_artists`) or label (via `tracks.label_id`), the summed pageviews of its demanded entities. The capture work queue ([track-work.ts](../apps/web/src/lib/server/track-work.ts)) reads it as a **secondary** sort key, `coalesce(demand_score, 0) desc`, AFTER `capture_priority`.
- **`crawl_frontier.demand_rank`** — `0` on the pending frontier nodes of a demanded entity (a demanded label's whole seed subtree via `label_slug`; an artist node matched by MBID), `1` on the rest. The pick order becomes `(state, hop, demand_rank, created_at, id)`.

Three constraints are load-bearing and non-negotiable:

- **Rank-order only, never magnitude, never an override.** Demand reorders WITHIN an existing tier — a demanded row is captured (or crawled) before an undemanded sibling _at its tier_, never lifted across it.
- **The veto always wins.** `demand_score` sits below `capture_priority`, and the `capture_priority >= 0` exclusion runs first (in `kindClause`), so a ruled-out label (tier −1) or a duplicate (−2) is never resurrected by demand however many pageviews it has. Breadth-first by hop is likewise preserved: `demand_rank` only tiebreaks within a hop.
- **The seed-allowlist gate is untouched.** A demanded label that is not an enabled seed has no pending frontier nodes, so promoting it does nothing — demand can never widen the crawl past the operator's rulings.

The rewrite is a full **clear-then-set** each run, so it is idempotent, deterministic, and bounded (the demanded set is the head of the pageview distribution). Unprovisioned (no key), the op is a clean no-op — it writes nothing at all, so a transient missing key never wipes the columns.

## What this does not do

- **It does not capture audio.** Not a byte. The acquisition layer is operator-gated and lives in the private companion repo; this repo knows only that "a captured full song appears in private R2 under a key."
- **It does not name the tier in public.** `catalogue` is the internal word — code, docs, `/admin`. It is never a label on a public surface. _Finding_ remains the only named object in Fluncle's world.
- **It does not judge.** No genre model, no quality score, no promotion. Turning a catalogue track into a finding is an act of certification, and certification is the operator's.
