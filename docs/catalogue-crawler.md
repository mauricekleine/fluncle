# The catalogue crawler

Fluncle's acquisition of **metadata**, and nothing else.

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

## Deterministic · resumable · polite · idempotent

**Deterministic.** The frontier is picked `order by hop, created_at, id` — breadth-first, so two runs over the same graph expand the same nodes in the same order.

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
- Every agent queue lives on `findings` (`enrichment_status`, `context_status`, the `backfill_*` columns) or joins through it (the capture queue's `findings.log_id is not null`). So a 10,000-row crawl enqueues **zero** enrich, capture, note, observe or video jobs. Without that join the first sign would be the invoice.

### What the crawl leaves `capture_status` as, and why that matters to someone else

The crawler writes `tracks` rows **without naming `capture_status` at all**, so the DDL default lands: **`'pending'`, with `source_audio_key` NULL, `source_audio_failures` 0, and `source_audio_attempted_at` NULL.** That is deliberate and it is the contract.

Today the capture queue cannot reach those rows — its predicate is `findings.log_id is not null`, and a catalogue row has no finding. That join is currently the **only** thing standing between a 10k crawl and 10k metered capture jobs, and the crawler does not widen it.

But `'pending'` is exactly the state a widened queue would want to consume, and there is a design for one: The Ear's **`capture_priority` ladder** (`docs/the-ear.md`) — logged-artist > label-with-a-finding > enabled-seed-label > nothing, with an operator-**disabled** label vetoed outright. So the crawl leaves every row in the honest "never attempted" state, carrying the label and artist metadata the ladder scores on, and lets the ladder decide who is worth buying audio for. **The crawler does not widen the capture queue itself** — it just does not poison the well for whoever does.

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
- `release` — expands into the tracks it carries (the write) and the artists on them.
- `artist` — expands into that artist's other releases.

`id` is deterministic (`<source>:<kind>:<external_id>`), so re-discovering a node the walk already holds is an `on conflict do nothing`, not a second traversal — which is what keeps a graph full of cycles (two artists on one release each pointing back at it) from looping forever.

Reliability follows the shipped `backfill_*` convention verbatim: `attempted_at` / `attempts` / `failures` / `done_at`. A failed node backs off exponentially on its consecutive-failure count and is retried by a later tick; past 5 failures it stays `failed` and is never picked again. `parent_id` records the edge that discovered a node, so a bad subtree is traceable and prunable; `label_slug` carries the enabled seed the whole subtree descends from.

## What this does not do

- **It does not capture audio.** Not a byte. The acquisition layer is operator-gated and lives in the private companion repo; this repo knows only that "a captured full song appears in private R2 under a key."
- **It does not name the tier in public.** `catalogue` is the internal word — code, docs, `/admin`. It is never a label on a public surface. _Finding_ remains the only named object in Fluncle's world.
- **It does not judge.** No genre model, no quality score, no promotion. Turning a catalogue track into a finding is an act of certification, and certification is the operator's.
