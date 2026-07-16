# The catalogue crawler

Fluncle's acquisition of **metadata**, and nothing else. The crawler is a **probe**: it charts, it measures, it never speaks. Nothing it brings back is a finding.

The crawler walks the MusicBrainz release graph outward from the record labels the operator has **enabled** and writes catalogue rows into `tracks`. A catalogue track is a `tracks` row with **no `findings` row** — that is the entire definition, and it is what the crawler can and cannot do, expressed as a schema rather than as a rule (see [track-lifecycle.md](./track-lifecycle.md) for the tracks/findings split).

It cannot certify anything, because a crawler has no ears. It captures no audio. It writes no note, no video, no observation, no Log ID. It just brings back names.

**It is one half of the catalogue domain.** The crawler makes the rows exist; [The Ear](./the-ear.md) makes the pile useful — `/admin/catalogue`, ranked by how close each row sits to a finding the operator already loves. They share a table, a CLI group (`fluncle admin catalogue`), an oRPC domain, and a loop: the `fluncle-crawl` cron writes rows every 10 minutes and the `fluncle-rank` cron ranks them every 30. Neither can certify anything.

## What it is for

The archive is ~60 findings — every one heard, judged, and coordinate-stamped by the operator. The catalogue is the rest of the sky: the tracks Fluncle's instruments can measure without him ever standing there. Dense enough, it becomes a retrieval space — the fuel behind "more like this", the `/mix` rail, and the operator's own dig. Sparse, it is nothing.

The crawler's job is to make it dense **without ever letting an uncertified track pass for a finding.**

## The boundary gate: seed labels + graph distance

There is **no genre inference**. No MusicBrainz tag, no Discogs style, no BPM band, no classifier. That is ratified, and it is not an omission — it is the design.

The operator already drew the boundary when he ruled on the labels. Every label in the archive carries a `seed_state` (`enabled` / `disabled` / `undecided` — [label-entity.md](./label-entity.md)), and that column answers exactly one question: **may the next crawl seed from this label?** The crawler's only job is to not leave the neighbourhood:

| hop   | what it is                                                    |
| ----- | ------------------------------------------------------------- |
| **0** | a release on a label whose `seed_state` is `enabled`          |
| **1** | an artist who appears on such a release                       |
| **2** | a release that artist **also** appears on                     |
| —     | **STOP.** `maxHop` (default 2, ceiling 3) ends the walk here. |

A node past the limit is never enqueued, so the walk **terminates by construction** rather than by a watchdog. Set `--max-hop 0` and the crawl never leaves the seed labels' own releases at all.

The one hard-coded exclusion is an identity, not a judgement: MusicBrainz's **"Various Artists"** placeholder is credited on every compilation ever pressed, so following it as a hop-1 artist would walk the crawler out of drum & bass and into the whole of recorded music in a single step.

### The widening loop — the crawler proposes, the operator rules

A label the walk **discovers** that nobody has ruled on enters as `undecided` (the `labels` DDL default) and surfaces as a row in the `/admin` attention queue. It is **not crawled.** The next crawl seeds from it only once the operator enables it.

That is how the boundary widens without ever leaving his hands: the crawl reaches an artist's other label, says "here is one I found," and stops. One keystroke at `/admin/labels` decides whether the next crawl goes there. Ruling on a label is OPERATOR tier (`update_label`); the crawl itself is agent tier. **Disabling a label is crawl SCOPE, never storage** — it removes the label from the next crawl's seed set and touches nothing already stored.

A label the crawler discovers under a different spelling from one he has already ruled on does **not** re-enter the queue, **and the crawled track is written with the archive's spelling, not the vendor's.** The archive spells it `Medschool`; MusicBrainz spells it `Med School`. The fold collapses both to `medschool`, and the row is written as `Medschool`.

That second half is not tidiness — it is what keeps `slugify(tracks.label) = labels.slug` true by construction for every crawled row, and **every label consumer already assumes it.** [The Ear](./the-ear.md) keys every rung of its capture-priority ladder on that join, including the `skipped-label` **veto** whose whole job is to keep the metered capture budget off a label the operator ruled out. Write the vendor's spelling and `med-school` matches no label, so the label rungs and the veto go silently dead on every crawled row. Measured on a real Medschool crawl: **512 of 735 rows sat at tier 0, with nothing at tiers 1 or 2** — the ladder was half-dead and nothing said so. With the fold, those same 512 rows land at **tier 2** ("its label already carries a finding") and no row is tier 0.

A genuinely new label is minted from MusicBrainz's spelling and the track carries that same spelling, so the two agree by construction there too.

## Why MusicBrainz carries the walk

| source          | role                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------- |
| **MusicBrainz** | **the graph AND the identity.** Label → releases → recordings (+ ISRCs) → artists → releases |
| **Discogs**     | release/master ids, reached through MusicBrainz's curated `url-rels` — **zero API calls**    |
| **Spotify**     | a per-track ISRC lookup for the `spotify_uri`/`spotify_url` anchor. Optional.                |

**MusicBrainz is the only recording-centric source of the three**, and a track-level catalogue needs exactly that. Its graph supports the hop model cleanly and completely: `/release?label=<mbid>` and `/release?artist=<mbid>` are paginated browse endpoints, and one `/release/<mbid>?inc=recordings+artist-credits+isrcs+labels+url-rels` brings back a release's whole tracklist — every recording MBID, its ISRCs, its artist credits, its length, its label, and the Discogs relation — in a single request. It is CC0 and needs no token.

**Discogs cannot be the spine, and this is worth stating plainly rather than working around.** Discogs is _release_-centric: it has no recording entity and no ISRCs, so it cannot supply a stable per-track identity. Crawling it would produce rows that could not be deduped against each other or against a finding. So the crawler does not call the Discogs API at all — it reaches the Discogs release graph through the join that already exists, MusicBrainz's **human-curated `discogs` `url-rels` relation**, which arrives free in the same request that brought the tracks and lands as `tracks.in_release_id` / `in_master_id`. In the pilot that filled a Discogs id for **68%** of crawled tracks, at zero marginal request cost.

**Spotify is demoted, deliberately.** Its February-2026 lockdown removed the batch track-fetch endpoint, capped `/search` at 10 results, and stripped `genres`/`popularity`/`label` from the payloads — so it can be neither the traversal nor the identity. What survives is the `isrc:` search filter, which is an exact key lookup, and that is the one job it still does well. `tracks.spotify_uri` / `spotify_url` are nullable precisely so that a track with no Spotify presence is an unremarkable row rather than a failure. In the pilot the anchor resolved for **99% of tracks that had an ISRC** (148/149).

**The anchor grew a second rung, because ISRC recall over the pending pool measured ~zero.** Most catalogue rows exist on Spotify under a _different_ release than the one the crawl walked — "Dribble" by Muffler was logged off a Hospital festival compilation but lives on Spotify as its own single; "Lounge (DC Breaks Remix)" by Hold Tight came off a RAM release but is on Spotify via a Spearhead compilation — so the recording's ISRC never appears in Spotify's index (and many crawled rows carry no ISRC at all). An anchored row is what feeds the private "Fluncle's Telescope" playlist, so recall here directly grows the operator's discovery radio. So `fillSpotifyAnchors` is a **two-rung ladder, per row**: the exact-ISRC lookup first when the row carries one, then — only when it has no ISRC or the ISRC found nothing — a **verified title+artist search**. Precision is sacred: a wrong anchor poisons the telescope and the certify path, so the search rung stamps ONLY on a candidate passing ALL THREE of a **verification triple** — a folded ARTIST match, a folded TITLE match, and a duration within **±2s** of the row's — computed through the ratified `matchKey` fold (`track-match.ts`), which deliberately keeps a remix/VIP descriptor part of the identity, so the original of a logged VIP can never anchor to the VIP. If several candidates verify the closest duration wins; if none do, no stamp and the row stays in rotation. A miss is fine; a wrong stamp is not. The worklist leads with a **priority head**: up to half of every pass goes to the ear's TOP un-anchored candidates (highest `nearest_finding_score` first, duplicates/dismissed/long-form excluded — an anchor the telescope can actually board), and the fair track-id rotation fills the rest; the priority head never moves the rotation cursor. Measured before the head existed (2026-07-16): only 10 of the ear's top 200 candidates carried an anchor, so the telescope was drawing from the best-anchored sliver rather than the best candidates. The search is the heavier call, so it runs on its own per-tick budget (`ANCHOR_SEARCH_BUDGET` = 10, below the 20-row walk) — a row it skips this tick simply comes round on the next rotation, and a row with NO measured duration (a MusicBrainz recording without a length is stored as `duration_ms = 0`) never spends a call at all — its triple is unverifiable, so a search would be a guaranteed no-stamp.

**The anchor fill has a durable breaker, and its state is not silent.** The fill (`fillSpotifyAnchors`) runs as its own bounded step (`ANCHOR_BUDGET` = 20/tick), and its worklist is derived (`spotify_uri is null`, over the non-finding rows — no longer gated on `isrc is not null`, since the search rung exists precisely for the no-ISRC rows), so an anchor a tick misses is picked up by the next. A 429 from EITHER rung is a throttle that stops the pass identically. (The `anchorsPending` gauge on `get_crawl_status` stays on the ISRC-bearing slice of that worklist — the cheap `tracks_anchor_queue_idx` partial index — as a lower-bound gauge, because counting the whole un-anchored catalogue on every status read is the growing-table scan the DB rules forbid.) But a _sustained_ "Spotify won't answer" regime — a 429 the app earned app-wide, or a lost/expired `spotify_auth` grant — would otherwise report `anchorsFilled: 0` every tick with no reason an operator could act on, forever (measured 2026-07-14: a 12h journal summed `anchorsFilled: 0` across 59 ticks while `catalogue status` reported `anchorsPending: 5446`). So the fill is wrapped in a persistent breaker on the `settings` KV (`spotify-anchor-breaker.ts`, mirroring the Apple sibling's `apple-breaker.ts`): K consecutive failing passes TRIP it, while tripped it makes no Spotify call at all, and a healthy pass RESETS it. Each pass reports an `anchorOutcome` (`filled` / `ok` / `throttled` / `unauthorized` / `breaker_open`), and `get_crawl_status` (→ `fluncle admin catalogue status`) surfaces the breaker's `spotifyAnchor` state — `throttled` self-heals when the throttle lifts; `unauthorized` is the operator's cue to reconnect Spotify from `/admin`. So `anchorsFilled: 0` is never ambiguous between drained, throttled, unauthorized, and paused.

## Deterministic · resumable · polite · idempotent

**Deterministic.** The frontier is picked breadth-first (`order by hop, created_at, id`) **within a kind-aware split**: release nodes are guaranteed half of every batch (rounded up) whenever any are pending, and the discovery kinds (label/artist) fill the rest from the same breadth-first order. The split is the 2026-07-16 starvation fix — a pure `hop asc` drain let a wave of 2,015 hop-1 artist nodes sort ahead of 39k hop-2 releases, and since only a RELEASE node writes tracks, `tracksWritten` sat at zero for eight hours while every artist expansion enqueued ~9 more releases to the back of the line. With the split, acquisition and discovery advance together and neither kind can starve the other; two runs over the same graph still expand the same nodes in the same order.

**Resumable.** Every scrap of walk state lives in the `crawl_frontier` table, never in a process. A crawl is a **marathon the schedule finishes, not the process** — the neighbourhood of one seed label is hundreds of releases at one request per second. So "run again" and "resume" are the same command, and a box reboot mid-label costs one node, not one crawl. A paginated node (a label's or an artist's release list) stays `pending` with its browse cursor advanced, so a 900-release label drains across ticks instead of blowing one.

**Polite.** Every MusicBrainz call goes through the one shared client (`lib/server/musicbrainz.ts`): an identifiable `User-Agent`, ~1 req/s serialized across the whole isolate, and `Retry-After` honoured on a 503. An exhausted 503 means the vendor is actively throttling us, and the pass **stops** on its circuit breaker rather than grinding the same wall — the shipped `fluncle-backfill` discipline, reused, not reinvented. (That module was _extracted_ from the two near-identical copies that already lived in `discogs.ts` and `artist-resolution.ts`, so the artist sweep, the Discogs bridge and the crawler now share **one honest rate budget** instead of keeping three and tripling the real request rate.)

**Idempotent**, in two layers, because one is not enough:

1. A bounded pre-read over each batch's ISRCs and minted ids (`tracks_isrc_idx`). The ISRC is the recording's real identity, so a track Fluncle has already **certified** — whose `track_id` is a Spotify id, not an `mb_…` one — is recognised and skipped. Without this the crawler would quietly shadow a finding with an uncertified twin.
2. `on conflict (track_id) do nothing` on the insert, closing the race the pre-read cannot (two ticks, same recording) at the primary key.

A catalogue track's `track_id` is `mb_<musicbrainz-recording-id>` — deterministic, so re-crawling the same recording collides on the PK and writes nothing. **A re-crawl of the same graph writes zero new rows.**

## The certification rail

`llms.txt` asserts, truthfully, that _"every track in the archive is one he found, listened to, and certified."_ One crawled row leaking into a feed makes that sentence a lie. So the firewall is structural, and it is tested:

- The crawler contains **no `insert into findings`**. It cannot mint a coordinate.
- Every finding read drives through the `findings join tracks` inner join (`FINDINGS_FROM`), so `/log`, `/api/v1/tracks`, the RSS feed, the sitemap, the Galaxy game's star field, search and "more like this" are structurally blind to a crawled row — **including when it carries a perfect embedding.** You cannot fly to a waypoint that was never dropped.
- Every SPEAKING queue lives on `findings` (`enrichment_status`, `context_status`, the `backfill_*` columns) or joins through it, so a 10,000-row crawl enqueues **zero** enrich, note, observe or video jobs — those are certification concerns and stay blind to a crawled row. Capture is the one queue that now DOES reach a catalogue row (it is a measurement, on the catalogue-aware `list_track_work`), and there the thing standing between the crawl and the invoice is not a join but the **capture budget's default-deny brake**: it ships PAUSED, so the sweep narrows to the findings until the operator opens it (docs/gpu-batch-embed.md, docs/the-ear.md § The capture budget).

**The rail held; the LABEL it mints needed a page worth serving.** The crawler writes no finding, so no crawled TRACK ever reached a feed, a sitemap, or the star field — that half was airtight and stayed airtight when it was tested at volume. But the crawler DOES mint a `labels` row for every label it discovers (it must — that `undecided` row is the ruling queue), and a label row carries a **public page**. Measured against a 10,800-row synthetic catalogue, **eight `/label/<slug>` pages were live for labels Fluncle has never certified a thing on**, each one a wall of Spotify outlinks under the line _"Nothing logged off this one yet."_ — a doorway page.

The fix is **not** to withhold the page. A label with hundreds of crawled releases and no finding is a genuinely useful page, and serving it is the point of crawling. What was broken was the **hollow rendering**: a heading announcing findings that were not there. Graph pages now render every section **conditionally** (no findings, no findings section, no apology) and a thin-content gate on **total** renderable tracks keeps a two-row stub out of the index. So a discovered label with real depth is a real page, and the sitemap carries it. The full rule lives in [album-entity.md](./album-entity.md#an-entity-earns-a-page-on-its-content-not-on-fluncles) — **an entity earns a page on its content, not on Fluncle's.**

**All THREE crawl-minted entity kinds now share this posture — label, album, and artist.** The crawler mints `albums` and `artists` rows too (folded on the release-group MBID and the stable Spotify artist id), and each is public exactly as a discovered label is: a findings-free `/album/<slug>` or `/artist/<slug>` renders on its tracklist, findings first, and enters the sitemap once it clears the same thin-content floor (`listAlbumSitemapRows` / `listArtistSitemapRows`, counting findings PLUS the quieter catalogue rows). What stays archive-bounded is the EDITORIAL hubs — `/artists`, `/labels`, `/albums` are still Fluncle's own findings-joined lists, deliberately not swelled to catalogue size. And the crawled **TRACK** tier is untouched: a catalogue track still earns no coordinate, no `/log` URL, and no `/track` route — it renders unlit, linking out to Spotify (docs/album-entity.md, docs/artist-relationship.md).

### What the crawl leaves `capture_status` as, and why that matters to someone else

The crawler writes `tracks` rows **without naming `capture_status` at all**, so the DDL default lands: **`'pending'`, with `source_audio_key` NULL, `source_audio_failures` 0, and `source_audio_attempted_at` NULL.** That is deliberate and it is the contract.

The capture queue now REACHES those rows — the `fluncle-capture` sweep reads the catalogue-aware `list_track_work` (`kind=capture`), which serves `tracks` outer-joined to the certification. What stands between a 10k crawl and 10k metered capture jobs is no longer a join it happens to fall outside of; it is the **capture budget** — a default-deny kill switch plus a rolling-24h count/byte cap, consulted at the queue before the worklist is even selected. It ships PAUSED, so a fresh crawl's rows are invisible to the sweep until the operator deliberately opens the budget.

And `'pending'` is exactly the state the queue consumes, ordered by The Ear's **`capture_priority` ladder** (`docs/the-ear.md`) — logged-artist > label-with-a-finding > enabled-seed-label > nothing, with an operator-**disabled** label vetoed outright (tier −1, excluded by SQL predicate). So the crawl leaves every row in the honest "never attempted" state, carrying the label and artist metadata the ladder scores on, and lets the ladder decide who is worth buying audio for. **The crawler writes only that neutral state** — it never touches the budget or the priority; it just does not poison the well for the queue that drains it.

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

## The pilot, measured

One seed label (`Medschool`), crawled to a **complete drain** at hop 0 against a local dev database. Real numbers, not estimates:

|                                                                 |                                                                                                     |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Frontier nodes expanded                                         | **171** (1 seed + 1 MusicBrainz label + 168 releases + 1 browse page)                               |
| Tracks found on those releases                                  | **1,579**                                                                                           |
| Catalogue rows written                                          | **735**                                                                                             |
| Skipped as duplicates                                           | **844** — the same recording on a compilation, a reissue, a remaster                                |
| Failed nodes                                                    | 0                                                                                                   |
| New labels discovered                                           | 0 (`Med School` folds to the already-ruled `Medschool`)                                             |
| Discogs id attached (via MB `url-rels`, zero Discogs API calls) | 456 / 735 = **62%**                                                                                 |
| Cover art attached                                              | 618 / 735 = **84%**                                                                                 |
| `findings` rows written                                         | **0**                                                                                               |
| Wall clock                                                      | **3m 48s**                                                                                          |
| Capture-priority ladder, after ranking                          | 223 at tier 3 (artist on a finding) · **512 at tier 2** (label carries a finding) · **0 at tier 0** |

**The 844 duplicates are the headline.** More than half of what the graph offers is the same recording pressed again — which is exactly why the dedupe is on the recording's identity (ISRC, else the MB recording id) and not on a release.

**Idempotence, proven on the same live graph.** The whole frontier was re-opened and all 171 nodes re-walked. It found the same 1,579 tracks, **skipped all 1,579**, and wrote **0**. The archive went 795 rows → 795 rows.

The Spotify anchor resolved **148 / 149** ISRCs in an earlier pass — and then earned a 429, which is how the inline lookup got found out and moved to its own bounded step.

## The shape of the frontier

One row of `crawl_frontier` is one node of the graph and one unit of work.

- `label` — hop 0. Two flavours, and the pair is what makes label resolution itself resumable: the **seed** (`source: 'fluncle'`, `external_id` = the operator's `labels.slug`) expands into the MusicBrainz **entity** (`source: 'musicbrainz'`, `external_id` = the MB label MBID), which expands into its releases. A label MusicBrainz does not know is `skipped` with a reason — recorded honestly, never retried forever.
- `release` — expands into the tracks it carries (the write) and the artists on them. In the same pass it stamps the graph edges INLINE: `tracks.label_id` (folded on the label slug), `track_artists` for any artist Fluncle has already certified, and — folded on the release's MusicBrainz **release-group MBID** (`inc=release-groups`, slug as the fallback) — the `albums` row and `tracks.album_id` pointer. The album edge is written off the bat now, not deferred to a deploy backfill; the one-off `scripts/backfill-album-graph.ts` only catches history up. See [album-entity.md](./album-entity.md#how-a-row-gets-minted).
- `artist` — expands into that artist's other releases.

`id` is deterministic (`<source>:<kind>:<external_id>`), so re-discovering a node the walk already holds is an `on conflict do nothing`, not a second traversal — which is what keeps a graph full of cycles (two artists on one release each pointing back at it) from looping forever.

Reliability follows the shipped `backfill_*` convention verbatim: `attempted_at` / `attempts` / `failures` / `done_at`. A failed node backs off exponentially on its consecutive-failure count and is retried by a later tick; past 5 failures it stays `failed` and is never picked again. `parent_id` records the edge that discovered a node, so a bad subtree is traceable and prunable; `label_slug` carries the enabled seed the whole subtree descends from.

## What this does not do

- **It does not capture audio.** Not a byte. The acquisition layer is operator-gated and lives in the private companion repo; this repo knows only that "a captured full song appears in private R2 under a key."
- **It does not name the tier in public.** `catalogue` is the internal word — code, docs, `/admin`. It is never a label on a public surface. _Finding_ remains the only named object in Fluncle's world.
- **It does not judge.** No genre model, no quality score, no promotion. Turning a catalogue track into a finding is an act of certification, and certification is the operator's.
