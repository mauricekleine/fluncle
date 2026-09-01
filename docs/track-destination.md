# The archive track destination

Fluncle holds far more recordings than he has ever certified. A certified one is a **finding** and lives at `/log/<coordinate>`. Everything else — the rows the [catalogue crawler](./catalogue-crawler.md) and the freshness tap put in `tracks` — had no destination at all: it rendered as a quiet line on an [entity page](./album-entity.md) whose only way out was a streaming service. `/track/<trackId>` is that destination.

## The certified rail did not move

Read this first, because everything below is built on it.

- A `tracks` row with no `findings` row is **not** a finding, has **no coordinate**, and **never gets a `/log` URL**. That rail is absolute and is unchanged.
- `/log/<coordinate>` keeps its URL, its identifier and its response, byte for byte. A `/track/<trackId>` that resolves to a certified row is a **permanent 301 to `/log/<coordinate>`** — this route never mints a second URL for a finding.
- The `findings` sitemap child is still bounded by the archive Fluncle has certified. A 30,000-row crawl adds exactly zero `/log` entries. What it adds now is entity pages (as before) **and** track destinations (the new `tracks` child), never a coordinate.

What changed is one sentence in [album-entity.md](./album-entity.md): a crawled track used to earn nothing at all. It now earns a page — with no name, no noun, and no coordinate on it.

## The identifier

**The address is `tracks.track_id`, the row's own primary key.** The full argument is in the header of [`apps/web/src/lib/track-page.ts`](../apps/web/src/lib/track-page.ts); the four properties that decided it:

1. **Permanence under correction.** Every other candidate on the row is metadata, and metadata gets fixed. `track_id` is assigned once at insert and never rewritten: the crawler's `mb_<recording-mbid>` and the freshness tap's `sp_<spotify-track-id>` are deterministic functions of an identity that already existed, so re-crawling the same recording collides on the primary key and writes nothing.
2. **It exists for every row.** `tracks.isrc` is the better recording anchor and it is what the archive reconciles on, but it is nullable — `isrc_attempted_at` exists precisely because "we looked and there is none" is a real answer. An ISRC-keyed URL needs a second scheme for every row without one.
3. **A late ISRC changes nothing.** Under an ISRC-keyed URL, the day a backfill fills that column the page's address moves — a redirect owed forever, on a column four fill paths write to. Under the primary key a late ISRC is one more fact the page prints.
4. **One recording, one page.** An ISRC is not unique per _row_: the same recording reaches the catalogue under several barcodes. An ISRC-keyed URL would have to choose one of those rows and would choose a different one as the crawl grows. The archive already answers that ambiguity with `duplicate_of_track_id`, and the destination follows the stamp with a 301 to the principal — **in one hop**. That column is written only when a catalogue row's ISRC matches a _finding's_, so the principal is nearly always certified and a `/track/<principal>` bounce would only 301 again to `/log`; the principal's coordinate is read in the same select so the twin lands on the real page directly. The `/track` arm survives for the case the column's rule does not cover, a principal carrying no coordinate.

The address is guessable only in the sense any primary key is — a stable opaque token, not a counter — and nothing behind it is private: every field the page prints is already public through `/api/v1`, the feeds, and the entity pages.

## The two predicates

They live together in [`apps/web/src/lib/server/track-page.ts`](../apps/web/src/lib/server/track-page.ts) and answer different questions. Collapsing them would be a defect.

**Sufficient identity** (`TRACK_PAGE_IDENTITY_WHERE`) decides whether the page **exists**: the archive can name the recording (a title and at least one artist credit) and no operator stamp has retired it (`dismissed_at`). Below it the route 404s. It is deliberately the lowest honest bar — a page for a row with no name is a page about nothing, and everything richer is evidence.

Its client-side twin, `hasTrackPageIdentity`, is what a rendered LIST row calls before it decides whether to link into the destination at all, so a row the destination would refuse never gets a link.

**Evidence** (`TRACK_PAGE_INDEXABLE_WHERE`) decides whether the page is **indexed**. Four terms, and each is something a reader needs for the page to be worth landing on:

| Term                                                     | What it means for the page                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| `album_id is not null`                                   | it belongs to a record, so it sits in the graph rather than dangling |
| `release_date is not null`                               | it can be placed in time                                             |
| `album_image_url is not null`                            | it is a page about a record, not a text stub                         |
| `spotify_url is not null or apple_music_url is not null` | it can send you somewhere to hear it, which is the whole errand      |

plus `is_catalogue = 1` (a certified row's destination is `/log`, and a 301 must never be submitted for indexing) and `duplicate_of_track_id is null` (so is a stamped twin's).

Tempo, key, ISRC, label, the preview and the neighbours are **not** gates. They are enrichment, and gating on them would make indexability oscillate with a sweep's backlog.

A page that clears identity but not evidence still serves **200**, still carries every link, and is still crawlable and citable. It renders `noindex, follow` and stays out of the sitemap — the same posture `/identity/<key>` and a below-floor `/album/<slug>` already take.

### One definition, two consumers

The page's robots directive and the sitemap's membership **cannot drift**, because they are not two rules. The page does not recompute the predicate in TypeScript from the row it loaded: it asks the database to evaluate `TRACK_PAGE_INDEXABLE_WHERE` as a **column of the same select that loads the row**, and the sitemap read puts that identical string in its `where`. One expression, one constant.

### Why it is a conjunction of simple terms

It could have been a weighted score, and a score would have been prettier and unusable. This predicate runs over the whole `tracks` table for the sitemap — a table the crawler grows without bound — so it has to stay a shape the planner can drive off an index. Leading with `is_catalogue = 1` puts the read on the partial `tracks_is_catalogue_idx` and bounds it to the catalogue slice; every remaining term is a plain null test on a column.

`is_catalogue` stays what its column comment says it is: internal bookkeeping, used to **select** and never to **render**.

## What the page shows

Every band is conditional, and an empty one renders nothing at all — no heading, no empty state, no apology (the [graph-page rule](./album-entity.md), applied here).

- **The masthead** — the cover, the title, the artist credits as `GraphLink`s into `/artist/<slug>` wherever the entity resolves.
- **The facts** — released, length, BPM, key, album, label, ISRC, in the `/log` field block's shape with its ratified labels. Every one is conditional. That matters most for the ones whose "absent" is a VALUE rather than a null: `tracks.duration_ms` is NOT NULL and the crawler writes `0` as its honest unknown, and `isrc`/`mb_recording_id` carry a legacy empty string. A sentinel that renders is the same defect as a dead control — `0:00` is a length the archive does not hold, and `"duration": "PT0M0S"` asserts a zero-length recording to a crawler on a page that can still be indexed. All three are converted to a real absence at the DTO boundary, once, so the rendered field and the structured-data key disappear together.
- **The bounded preview** — the `/api/preview` relay, which serves only the official short clip a rights-holding service publishes (a stored Deezer URL, a fresh one by ISRC, Apple's exact-by-ISRC clip, then the keyless iTunes fallback). **Fluncle serves no full song from this page**; the captured full song is a private analysis artifact and is never a playback source. The control renders only when the archive holds a short-source anchor at all, and a relay that comes back empty returns the shared player to idle rather than erroring.
- **The outbound destinations** — one control per service the archive actually stores an exact link for. Nothing is composed from a search term: a wrong link is worse than an absent one. YouTube rides its officialness gate. Discogs is deliberately **not** here — it is a release database, not somewhere to hear a record — and rides the structured data's `sameAs` instead.

### Beatport is rendered, never asserted

`tracks.beatport_url`'s §F rail in `db/schema.ts` keeps the URL out of every derived corpus, because Beatport's terms bar using its content for text/data mining or for feeding AI. **A `sameAs` graph is a derived corpus** — `log-schema.ts` says in its own words that it exists "for crawlers + AI answer-engines" — and the certified `/log` page's `musicRecordingJsonLd` already withholds it. That shipped behaviour is the specification.

This page is the first surface that both renders a Beatport link _and_ composes a `sameAs` array from its outbound destinations, so it needs an explicit exclusion rather than an absence. The seam is `SAME_AS_EXCLUDED_LISTEN_KINDS` / `sameAsUrls` in [`apps/web/src/lib/track-page.ts`](../apps/web/src/lib/track-page.ts): the route's `head()` builds its `sameAs` input through it rather than mapping the destinations itself, the exclusion is keyed on the destination **kind** so it survives a rename or a URL-shape change, and `track-page.test.ts` fails if a future edit lets the kind through. The rendered control is untouched.

- **"Close in sound"** — the neighbours, and the half of the page that makes the archive traversable.

## Sonic neighbours

`/log`'s "more like this" asks a question about **findings** and scans the certified corpus. This one asks a question about **music**, so it scans `tracks` through a LEFT join and a certified neighbour competes on exactly the same terms as an uncertified one. The register a neighbour renders in is decided by whether it carries a coordinate, never by the query.

All four of [AGENTS.md](../AGENTS.md)'s database rules bind here and the scan obeys each one: the probe binds as a **raw blob**, the ranking happens **in SQL** and returns the ~8 winners rather than a column of vectors, there is exactly **one probe** so it is one pass (never `union all` branches over a CTE), and there is **no `libsql_vector_idx`** — an exact scan, which also means 100% recall.

### The tempo pre-filter

The exact scan carries the btree pre-filter AGENTS.md's hosted rail prescribes, the same shape `/mix`'s candidate scan already ships. **This one is on tempo, and the axis is a choice about the surface.** `key` is right for a mix (a harmonic move is defined on it) and wrong for "close in sound", because two recordings in unrelated keys can sit next to each other in the embedding space. Tempo is the opposite: a 90 BPM record is not close in sound to a 174 roller in anyone's ears, the page already prints BPM as one of its facts, and `tracks_bpm_idx` is a plain btree on the column. `galaxy` is unavailable by construction — `findings.galaxy_id` exists only on the certified half, and this band scans both registers.

The window is ±8% of the target's tempo (±14 BPM at 174). A hard filter has a cost and it is stated rather than hidden: a candidate with an unmeasured tempo, or a genuinely distant one, leaves the candidate set. Two degrades keep it from ever making the band _worse_ than the unfiltered answer — a target with no measured tempo has no window to build and scans unfiltered, and a windowed scan that comes back short of the limit is re-run unfiltered and the wider answer is used. That is one extra bounded query in the sparse case, which is the cheap case, and none in the dense case, which is the one the pre-filter exists for.

### The page is edge-cached

`/track/<trackId>` is enrolled in the entity **detail** tier (`edge-cache.ts`), 300s fresh / 3600s stale-while-revalidate. It earns that tier on both halves rather than inheriting it: its content is one row's enrichment plus its neighbours, so a re-enrichment should surface inside minutes exactly as it should on `/log/<id>` or `/album/<slug>`; and the invalidation is explicit rather than left to the window — `track` is an `EntityCacheKind`, and `getTrackEntityPurgeTargets` returns the track's own page alongside its artist/album/label pages, so every write path that already calls `purgeTrackEntityPages` evicts it too.

It matters more here than anywhere else in that tier: this is the surface with six figures of crawlable URLs behind it, an uncached view pays the exact vector scan above, and crawler traffic is uncached-first by definition.

Sonar is the lever when the embedded corpus outgrows the scan, behind its own dark flag (`sonar_track_enabled`, default off — see [vector-serving.md](./vector-serving.md)). Off, unprovisioned, timed out, or answering empty, the exact Turso scan answers. A track with no embedding, an archive with nothing else embedded, and a dark sonar all arrive as an empty list, and all three degrade to the same honest thing: **no band at all**.

## The sitemap at catalogue scale

`/track/<trackId>` gets its own child kind, `tracks`, and two things about it differ from every other kind.

**A lower per-child ceiling.** Every other kind is bounded by what Fluncle has certified or by how many entities exist, so their 45,000-URL ceiling is theoretical. This one is bounded by the crawl, so the ceiling actually fires and decides how much a single request has to build: 45,000 `<url>` elements is several megabytes of string assembled inside a 128 MB Worker isolate on every cache miss. `SITEMAP_TRACKS_MAX_URLS` is 10,000 — a few hundred kilobytes, at the cost of more files, which is exactly what a sitemap index is for.

**The window is in SQL.** Every other kind reads its whole bag and lets the builder slice it. Reading this one whole would pull a six-figure column into the isolate, which is the shape AGENTS.md forbids, so `collectSitemapBag("tracks", page)` applies the `limit`/`offset` itself and the kind is listed in `SITEMAP_SQL_WINDOWED_KINDS` so the builder does not window it a second time. The order is `track_id` — a primary key, stable while the crawl grows underneath a crawler walking the children one at a time; a date order would reshuffle between fetches and hand the same page out twice while orphaning another.

**A track entry carries no `<lastmod>`.** `tracks` has no content-change timestamp, and a release date is a different claim. The entry is honestly undated, exactly as the `docs` and `galaxies` children are, instead of inventing a stamp a crawler would read as one.

## The tier still has no name

The rule that governs every string on this page and every row that links into it (DESIGN.md's Unlit Rule; [album-entity.md](./album-entity.md)):

> The tier has no public name. It is never introduced, never named, never given a noun, and never counted aloud.

The destination does not change that. A page is not a name, and a link is not a claim. The page speaks in the catalogue register — it says what the recording is, plainly, and never says what Fluncle thinks of it. Across the surfaces that now link into it (the entity pages, the `/tracks` hub, `/fresh`, the front door's release band, search, and the `list_tracks` API/MCP row, whose `url` is this destination for an uncertified row and the `/log` page for a finding — the same link the hub row makes, decided by the same identity predicate), the unlit row is still coverless, coordinate-free, dust-inked, and carries no gold at rest or on hover. The only thing that changed is where it goes.
