# The label entity

Fluncle keeps a canonical label entity and one operator control: which labels the catalogue crawler may seed from. Its public and operator surfaces are `/label/<slug>`, `/labels`, and `/admin/labels`.

The label is the third node of the graph the archive is becoming — **log ↔ artist ↔ label ↔ album**. Its structural twin, the album, is documented in [docs/album-entity.md](./album-entity.md), which also carries what the two share: the graph pointer on `tracks`, the mint-only-off-a-finding rule, the public page's shape, the unnamed quieter rows, and the thin-content gate. Read that doc for the page; this one owns the crawl-seed ruling.

## The data model

`tracks.label` is the immutable raw vendor string. The `labels` table is its normalized twin, related by slug:

```
slugify(tracks.label) = labels.slug
```

`tracks.label_id` is the indexed graph pointer used by public reads. See [docs/album-entity.md](./album-entity.md#the-graph-pointer-tracksalbum_id--trackslabel_id).

**The slug is the display identity and the fallback fold; the MusicBrainz label MBID (`mb_label_id`) is the stable fold key for a DISCOVERED label** — the label twin of the release-group MBID the album entity folds on. `slugify` cannot fold `Med School` and `Medschool` (they slug apart), so a crawler that minted a discovered label by slug alone would mint those two spellings as separate labels. Folding on the MBID collapses them: a UNIQUE index on `mb_label_id` (NULLs distinct — most rows carry none) makes `where mb_label_id = ?` a connect-or-create the crawler resolves BEFORE the slug path. When a caller carries an MBID and the resolved/minted row has none yet, it is **adopted fill-empty-only** (`where mb_label_id is null`), so a publish-minted label and the crawler's later discovery collapse into one row instead of duplicating, and a row already folded on a different MBID is never rewritten. The alias layer (below) stays the secondary defense for a NON-MusicBrainz source (Apple's `recordLabel`) and for the fold `slugify` can't do on its own.

| Column             | What it is                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`             | The display identity and the join key (unique). Minted by `slugify(name)`. Also the fold key when no MBID exists.                                                                           |
| `mb_label_id`      | The MusicBrainz label MBID — the stable fold key for a discovered label (UNIQUE, NULL for a publish-minted / pre-crawl row).                                                                |
| `name`             | The display name — the first raw spelling seen for that slug.                                                                                                                               |
| `seed_state`       | `enabled` \| `disabled` \| `undecided`. **Crawl scope, never storage** (below).                                                                                                             |
| `ruled_at`         | When a HUMAN last ruled. NULL = no operator has ruled it (a machine default, or the one-time bootstrap).                                                                                    |
| `scope_changed_at` | The crawl re-arm watermark — stamped on enable, on any artist-rule change for the label, and by an explicit `--rewalk`. Never touched by reads; `ruled_at` is never touched by rule writes. |

A label's **artist exceptions** live in the `artist_rules` table (`label_id` = this label; NULL = a global rule): `verdict: allow | block | unlisted`, keyed on the artist's MB MBID with a write-time-resolved Spotify bridge for the freshness tap. The exception model is the crawler's (three-layer verdict, FIRST-credit quantifier — [catalogue-crawler.md](./catalogue-crawler.md#the-boundary-gate-enabled-label-storage--graph-distance-discovery)); this document owns what the rows MEAN: a block carves an act out of an enabled label ("take the label, except them"), an allow carves an act into a disabled one ("skip the label, but always take them"). A label **merge never unions rules**: the survivor keeps its own, the loser's are dropped and reported (`droppedRules`) for deliberate re-authoring.

**`unlisted` is the third verdict and it is a different axis: VISIBILITY, not acquisition.** It is **GLOBAL-ONLY** — a page is not per-label, so the whole-set `PUT /admin/labels/{id}/artists` refuses it at the contract boundary and the server refuses it again (`LabelScopedUnlistedRuleError` → 400) — and it is **VISIBILITY-ONLY**: at the crawl-time gate it is inert, so an unlisted act's records store exactly as the label's seed state decides, as if no rule existed. It exists for the shape MusicBrainz forces on the crawler: a remix is billed to the ORIGINAL artist, so a drum & bass remix of a pop song mints an artist entity for the pop act. `unlisted` keeps the remix and takes the pop act's `/artist/<slug>` page off the site ([artist-relationship.md](./artist-relationship.md)). Visibility is derived at READ time from the rule, never stamped on the `artists` row, so authoring or removing it flips every public surface at once with no backfill — the only lag is the edge cache, which the write purges.

**One global ruling per artist, and all three verdicts share that slot.** `artist_rules_global_artist_idx` is unique on `artist_mbid` where `label_id` is null, so a global `unlisted` and a global `allow`/`block` are mutually exclusive: a second global add returns 409 naming the verdict already held, and the operator clears it before setting another. A **per-label** `allow`/`block` is a separate slot and coexists with a global `unlisted` freely, so an act can be hidden from the site and still have its acquisition carved per label. The one combination the storage cannot express is "global allow AND no page"; splitting visibility onto its own column is the fix if that need arises.

Derive a label's finding count with a grouped read; do not store it.

## Crawl scope, never storage

This is the ruling, and it is the whole point of the control. **`seed_state` answers exactly one question: may the future catalogue crawler seed from this label?**

- **`disabled`** removes the label from the **next** crawl's seed set. It touches **nothing already stored** — no deletion, no hiding, no retroactive effect on tracks, on findings, or on anything a previous crawl already brought in. A disabled label's findings keep rendering exactly as they did before, and its finding count keeps counting them.
- **`enabled`** means the next crawl may dig from it.
- **`undecided`** is where a brand-new label enters: **never silently crawled, never silently dropped.** It surfaces in the `/admin` attention queue until a human rules on it.

`seed_state` affects crawl acquisition only. It does not affect storage, rendering, indexability, or sitemap membership.

The same axis governs artist rules, so the restatement covers both: **a ruling and its artist rules govern what Fluncle _acquires_ next — what the crawler seeds from, what it takes, and what audio gets bought. Nothing ever changes what is already stored.** Removing already-stored content is the fluncle-catalogue-prune skill's job, a separate deliberate act.

**Prefer an existing MB entity over artist rules when the boundary is a product line.** Some labels already carry the granularity as MB imprint children (Med School under Hospital; 3 Beat Breaks under 3 Beat) — machine-checkable via `?inc=label-rels`. When an imprint child covers the boundary, rule on the child entity; use artist rules when the label is one imprint with mixed output. Never use ℗-holder entities as a mechanism.

## How a label gets a row

Three ways automatically, all idempotent, plus one the operator fires by hand:

1. **The publish path** — `publishTrack` calls `ensureLabel(deezer.label)` right after it upserts the artist entity. Best-effort and purely additive (one `labels` row, nothing else), so a failure never blocks an add. No MBID (Deezer hands back a string), so it folds by slug/alias.
2. **The catalogue crawler** — at discovery `applyRelease` calls `ensureLabel(mbLabelName, mbLabelId)` with the MBID off the release's `label-info[].label.id`, so a discovered label **folds on the MBID** and its `tracks.label_id` edge is stamped inline (`linkTracksToLabel`, MBID-first then slug). The SEED path stamps the same column via `setLabelMbLabelId` — both fill-empty-only, so they never fight.
3. **The deploy-time reconcile** — `scripts/backfill-labels.ts` runs as part of `db:backfill` in `deploy:cf`, ensuring a row exists for every distinct `tracks.label` and stamping any missing `label_id` pointer. The self-healing backstop for a writer that does not stamp inline.
4. **The operator's mint, by MusicBrainz identity** — `mint_label` (`fluncle admin labels mint <mbid>`, operator tier). The three doors above are all side effects of something else, so none of them opens for a label nothing has walked to yet: the Worker looks the MBID up through the shared rate-limited MusicBrainz client and folds the answer through the SAME `ensureLabel(name, mbLabelId)` connect-or-create the crawler uses. `lib/server/label-mint.ts`.

An existing label is never clobbered: its seed state, its ruling stamp, its display name, and any MBID already on it all survive.

**Why the fourth door exists, and what it deliberately does not do.** The case it is for is an upstream MusicBrainz conflation split: when a conflated label entity is split, the drum & bass half often lands on a NEW MusicBrainz entity (or one Fluncle has never met), and the only automatic way in is for some later walk to reach one of its releases — which for a one-release imprint may be never. The mint reports what it did (`minted` a new row, `adopted` the MBID onto a row that already wore the spelling, or found the MBID already `known`) rather than a bare boolean, and it is idempotent: a known MBID short-circuits before the MusicBrainz call, so a re-run spends no request and writes no fact. MusicBrainz's disambiguation, `area.name` and `life-span.begin` land fill-empty-only (the lineage sweep's `coalesce` shape) — its `country` is the ISO code of the same area and its `type` has no column, so the row carries neither. `seedState` is OPTIONAL: given, it rules through the SAME `updateLabelSeedState` write `update_label` uses, so `ruled_at` and the re-arm watermark stamp identically; omitted, a new row lands at the table's `undecided` default and an existing row's ruling is left exactly where the operator left it, so a re-run can never un-rule a label. It certifies nothing, walks nothing, and writes no track. A slug that already belongs to a DIFFERENT MusicBrainz label is a 409 rather than a silent re-point — the `merge_label` stop-and-ask rule.

**The take-over: the one explicit way through that conflict.** A MusicBrainz split can move the drum & bass catalogue onto a NEW entity that keeps the ORIGINAL's NAME, leaving Fluncle holding a row for that name whose `mb_label_id` now points at an entity carrying only foreign catalogue. The row named "X" in the archive should simply BE the drum & bass X, so `mint_label` takes an optional `takeOverSlug` (`fluncle admin labels mint <mbid> --take-over <slug>`) that RE-POINTS that row's identity onto the minted entity and answers `taken_over`. It is never inferred: the take-over happens only when the operator names the row, and only when the named slug IS the row the mint collided with — a slug that is not gets a 400 (`take_over_slug_mismatch`) naming the row that actually conflicts, so a typo can never move a bystander's identity. The row must hold ZERO stored tracks (the maintained `renderable_track_count` over the `tracks.label_id` edge) and must not be `enabled`, else a 409 (`take_over_not_empty`): **a row with tracks is a merge, not a take-over** — its tracks have to travel to a row that keeps its own identity, which is exactly what `merge_label` does.

**What rides along with the NAME, and what goes with the replaced identity.** The row keeps its `id`, `slug` and `name`, so every public URL holds and everything keyed on the name travels: its `label_aliases` spellings (including the confirmed ones that stop the immutable `tracks.label` re-minting the slug), its `bio`, the CHILD labels whose `parent_label_id` points at it, and the Spotify freshness tap's cadence columns (that probe queries by label NAME, never by MBID). What does not travel is everything walked FROM the replaced entity: the label's own `artist_rules` are DROPPED and reported in the result (the `merge_label` `droppedRules` rule — a roster belongs to an identity), and `discogs_label_id`, the logo (`image_*`) and this row's OWN `parent_label_id` are cleared with `image_state` / `lineage_state` re-armed to `pending`, so the label-images and label-lineage sweeps re-walk them from the new identity instead of keeping a stranger's logo. MusicBrainz's disambiguation, area and life-span OVERWRITE here rather than filling empty, because the row is changing identity. All of it is one transaction.

**The frontier is retired with it.** A node keyed on the OLD MBID would keep browsing the stranger's releases the next time the label is enabled, and the seed resolver (`fluncle:label:<slug>`) mints the MBID's browse node exactly once and then sits `done`, so the new entity would never be enqueued at all. The take-over therefore stamps the old `musicbrainz:label:<old mbid>` node's `note` — retired, never deleted, so the walk history stays readable, and the crawl's own re-arm join already refuses a node whose `external_id` is not the label's current `mb_label_id` — and re-arms the resolver to `pending`, the two moves the fluncle-catalogue-prune skill's `reseed-label.ts` makes for the namesake repair. A row that was never enabled holds neither node and there is nothing to retire; the result reports zero rather than pretending it moved crawl state.

**A minted-then-enabled label is a seed on the very next crawl tick, and costs zero MusicBrainz requests to resolve.** Seeding reads the whole enabled set at the head of every tick and enqueues a `fluncle:label:<slug>` node for each enabled label the frontier does not already hold (`seedFromEnabledLabels`, crawl.ts:766), and a seed node whose label already carries `mb_label_id` skips the name search outright — the plan returns no search (crawl.ts:1583) and the expansion enqueues that MBID's browse node directly (crawl.ts:1845). So a label minted by identity is immune by construction to the namesake class the name search guards against.

**The publish path and the crawler DISAGREE about identity on purpose, and each is right for what it is doing.** Publish mints on a bare vendor string, MBID or no MBID, because a certified finding must have its label page — that is the whole point of the entity, and `tracks.label` is all Deezer hands back. The crawler walks BY identity, so its DISCOVERY path mints only when the release names a `label.id`: a `label-info` entry giving a name and no MBID identifies nothing, and proposing a row whose MusicBrainz entity nobody can name is the namesake class (a right ruling on a wrong identity — the fluncle-catalogue-prune skill's `references/traps.md`). Such a discovery is logged (`crawl.label-discovery-unidentified`), mints no row, enters no queue, and the release's tracks keep the raw string alone.

**A publish-minted row acquires its MBID from the crawler, off a release that states it.** When `canonicalLabelRow` recognises MusicBrainz's label under any spelling, the crawler adopts the release's `label-info[].label.id` onto that row — fill-empty-only, one write, and only for a row with something to gain. So identity arrives from an authority that named it, never from a name search that would guess between namesakes. The rows still carrying none are what `apps/web/scripts/count-labels-without-mbid.ts` reports, per seed state, with their track counts: an `enabled` one also self-resolves on its next crawl tick (`expandSeedLabel`'s exact-fold search with its ambiguity guard), while an `undecided` one never gets that tick — nothing crawls it until the operator rules — so it is his to resolve by hand, and the label-triage pull skips it until he has.

### MBID backfill

`scripts/backfill-label-mbid.ts` resolves labels lacking `mb_label_id` through the shared MusicBrainz client and stamps the result fill-empty-only. It logs collisions and never merges rows.

## The surfaces

**`/admin/labels`** is the management station (sidebar: Labels, beside Artists). Sections in the order the work arrives: _Waiting on a ruling_ (the queue), then _Seeding named artists_, then _Seeding from_, then _Not seeding_. An unruled row's two ruling buttons are the loudest thing on the page (the disclosure law); re-ruling a settled label is the rare act, behind the row's `⋮`.

**`undecided` is TWO sections, because a settled verdict is not a gap.** Writing per-label allows and leaving the seed state alone IS a ruling — the `dnb_partial` verdict of the [fluncle-label-triage](../packages/skills/fluncle-label-triage) skill: the label stays out of the seed set and the next crawl takes the named artists off it and nobody else. So _Waiting on a ruling_ is `undecided` AND carrying no per-label rule, and _Seeding named artists_ is the rest, each row stating how many artists it takes. The distinguishing check is EXACT rather than a heuristic (an undecided label has no other way to acquire per-label rules) and it is the same one the triage pull partitions on, so the station and the pull agree about what is still open. A GLOBAL rule (`label_id` null) is the other axis and never counts. The split is decided in SQL — one `exists` term on `artist_rules_label_id_idx` over the same `(seed_state, name)` index walk (`listLabelsPage`) — so the two sections are disjoint, their totals sum to the seed state's, and the **header count leads with the waiting set alone**: a number that calls 178 settled verdicts an open queue is a number the operator learns to stop believing. A settled-partial row keeps its ruling options behind the `⋮`; a WAITING row carries the third verdict there too ("Allow an artist from it…", the same whole-set rules dialog), since its two buttons cannot say it.

A label's SECTION follows its ruling, never its rules: an `enabled` label with blocks stays in _Seeding from_, a `disabled` one with allows stays in _Not seeding_. The split is the undecided pile's business alone.

Each ruling row displays the label name plus any MusicBrainz disambiguation, founding date and location, and an outbound MBID link.

**The attention queue** carries `label-review` as a source (`apps/web/src/lib/attention.ts`): every `undecided` label is one row, oldest-first, deep-linking to `/admin/labels`. It never rides the deadline tier — a ruling steers the next crawl and blocks nothing.

## The ops (`packages/contracts/src/orpc/admin-labels.ts`)

| op                           | tier                       | path                             |
| ---------------------------- | -------------------------- | -------------------------------- |
| `list_labels_admin`          | admin (agent-allowed read) | `GET /admin/labels`              |
| `mint_label`                 | operator                   | `POST /admin/labels`             |
| `update_label`               | operator                   | `PATCH /admin/labels/{id}`       |
| `list_label_artist_rules`    | admin                      | `GET /admin/labels/{id}/artists` |
| `replace_label_artist_rules` | operator                   | `PUT /admin/labels/{id}/artists` |

Global artist rules ride their own contract file (`admin-artist-rules.ts`): `list_artist_rules` (admin) plus `add_artist_rule` / `remove_artist_rule` (operator) on `/admin/artist-rules` — they belong to the artist entity's surface ([artist-relationship.md](./artist-relationship.md)), not to any label. `replace_label_artist_rules` is a transactional whole-set swap that resolves each rule's Spotify bridge from the artist's MB url-rels at write and stamps `scope_changed_at`; `update_label` gains `rewalk` for a bare re-walk arm.

`?seedState=enabled` is the crawler's agent-authenticated seed-set read. The `_admin` suffix distinguishes it from the public `list_labels` and `get_label` operations.

`update_label` is operator tier: ruling steers what Fluncle crawls next, which is an editorial act, so an agent token 403s at `operatorGuard` (the `update_galaxy` precedent). `mint_label` is operator tier for the same reason one rung earlier — bringing a label into the archive decides what may be crawled at all and what earns a public page. Both are enforced by the build-fail coverage tests (`orpc-auth-coverage`, `orpc-naming`).

The server layer lives in `apps/web/src/lib/server/labels.ts`.

## The public page

A label entity always has a public page.

Two things worth restating here, because both are about this entity specifically.

**The public page is blind to `seed_state`.** A label the operator skipped for the crawler renders exactly as it always did, and its findings keep counting. Crawl scope, never storage — no read behind the page knows the column exists.

Findings-free pages render their crawled discography, omit empty sections, and enter the index only when total renderable content clears the thin-content gate.

One consequence worth naming, because the two reads differ in SHAPE: **`/labels` and the sitemap are separate reads over the same floor-clearing set.** `/labels` is ONE unified A–Z index of every label Fluncle holds (`listLabelsHubPage`) — certified findings and the wider catalogue in one alphabetical `?page=N` surface, a certified label's name lit in Eclipse Gold, the rest unlit — for a human to browse; the sitemap (`listLabelSitemapRows`) is the machine's complete map, so it wants the WHOLE set at once (no paging) and only the slug + lastmod a `<url>` needs. Same floor, different shape, so a crawler-discovered page is linked AND sitemapped, never orphaned. The unified-index shape is documented once, in [docs/album-entity.md](./album-entity.md#the-sitemap-carries-every-page-the-hub-is-one-unified-index).

The crawl also bounds the `label-review` queue: `listLabelReviewRows` hands the attention queue a WORKING SET (`LABEL_REVIEW_QUEUE_LIMIT`, oldest-first), because a wide crawl proposes hundreds of labels and an uncapped source would drown the other five in the `/admin` cockpit, in its SSR payload, and in `fluncle admin queue`. `/admin/labels` remains the station where the full list is ruled on.

## The label's own image (its real logo, not a borrowed cover)

Every label carries its own image lifecycle on the `labels` row. Public and admin surfaces prefer the owned logo and fall back to the freshest finding cover when no logo resolves.

| Column                                  | What it is                                                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mb_label_id`                           | The MusicBrainz label MBID — the identity anchor AND the discovered-label fold key (UNIQUE; see the data model). The crawler resolves it at walk time (seed + discovered paths) and persists it. |
| `discogs_label_id`                      | The Discogs label id (off the MB label's curated Discogs url-rel) — the source of the logo image.                                                                                                |
| `image_key`                             | The R2 object key of the stored logo (`labels/<slug>.<ext>`), served world-readable from `found.fluncle.com`.                                                                                    |
| `image_state`                           | The resolve lifecycle: `pending` (the DDL default — every label enters the worklist), `resolved`, `none`.                                                                                        |
| `image_updated_at`                      | The `?v` bust VINTAGE, stamped by the resolve sweep's success write — the albums/artists column cloned across, so a replaced logo re-keys every rendition.                                       |
| `image_attempted_at` / `image_failures` | The reliability pair (the shipped `backfill_*` convention): transient failures back off; a persistent one gives up.                                                                              |

**Discogs is the source.** Labels are first-class on Discogs and `GET /labels/{id}` returns an `images[]` array with the real logo. The identity is reached the way `discogs.ts` already reaches releases — through **MusicBrainz's curated `url-rels`**, never through Discogs search — so the resolve walks: the label name → its MBID (`/label?query=`, exact-fold match, the crawler's `fold`) → `/label/<mbid>?inc=url-rels` → the Discogs (and Wikidata) relation. The logo is **downloaded once and stored in our own R2** (`env.VIDEOS`, behind `found.fluncle.com`) — Discogs is **never hotlinked**: their ToS forbids it and image requests need the authed token.

A supplied Discogs logo is stored only when its bytes match an allowed raster signature; the sniffed type becomes the public R2 `contentType`. The caller's MIME label and URL cannot make SVG markup or a non-image RIFF payload safe, and a benign `image/jpg` spelling does not reject genuine JPEG bytes.

**The fallback ladder** (explicit, tested in `label-images.test.ts`):

1. **Discogs label image** — the primary source (`discogs.ts::fetchDiscogsLabelImage`, both calls authed + on the shared Discogs rate-limit gate).
2. **Wikidata P154 (logo image)** — off the MB label's Wikidata url-rel, via Commons `Special:FilePath`. The second rung: cheap, because the QID is already in the url-rels walked for Discogs.
3. **The floor** — no image anywhere: `image_state='none'`, and every surface keeps rendering **exactly what it renders today** (the freshest finding's cover). A tiny artist-run label with no Discogs/Wikidata image degrades gracefully, never to an empty card.

**The resolve sweep** (`label-images.ts::resolveLabelImages`) is a bounded, idempotent, **Worker-paced** pass — the shipped `fluncle-backfill` discipline: the box holds no vendor keys, so the MusicBrainz walk + the authed Discogs fetches happen in the Worker and the box `--no-agent` cron drives one small batch per tick (`MAX_BATCH` labels). MusicBrainz is the shared 1 req/s client; Discogs is the shared authed gate; both report `rateLimited` and the sweep **circuit-breaks** on it (stops the pass, retries next tick with a fresh window). A `resolved`/`none` label is terminal and skipped forever, but `none` is reserved for a trustworthy absence verdict; Wikimedia/Discogs throttles, 5xx responses, and transport failures stay `pending`, back off on the cooldown, and retry rather than becoming a permanent false absence. **Idempotent by construction** — a second run over a fully-resolved archive fetches nothing.

**The durable path (`fluncle-label-images`).** The catalogue crawler mints new labels every few minutes, each landing at `image_state='pending'` — so the resolve sweep must be a RECURRING poller, not a one-shot backfill. The **`fluncle-label-images`** host timer (rave-02, hourly — [docs/agents/hermes/label-images-timer/](./agents/hermes/label-images-timer/README.md)) drives one bounded batch per tick via the same `fluncle admin backfills label-images` op, so a freshly-minted label gets its logo within the hour instead of sitting `pending` forever. The crawl makes labels exist; this sweep gives each a logo — the same loop the crawler and The Ear's ranking form. Hourly is plenty: the crawl mints only tens of labels/day and Discogs' 1 req/s ceiling means there is no prize for hurrying; a tick over a drained worklist is a cheap no-op. It is registered as `cron.label-images` in `@fluncle/registry` + the healthcheck prober's `AUTOMATION_CRONS`, so it appears on `/status` on its first tick. Like the other agent sweeps the box enable is operator-gated; the repo half (scripts + timer + this doc) ships here.

**The logo is served up the OWNED-COVER ladder, not as a raw object.** `media.ts::labelLogoUrl(imageKey, imageUpdatedAt, size)` delegates straight to `ownedCoverUrl`, so a label's logo goes out exactly as an album cover or an artist avatar does: a Cloudflare Images `/cdn-cgi/image/width=<rung>,format=auto/` rendition of the R2 master, with `?v=<image_updated_at>` riding the SOURCE so a replaced logo evicts every cached rendition. Same 64/300/640/1200 rungs, same `albumCoverAtSize` re-sizer — see [docs/album-artwork.md](./album-artwork.md). It is deliberately a thin delegation and not a `bestAlbumCoverUrl`-shaped three-way: a label has no second image provider, and the cover fallback belongs to the surface, because only the surface knows whether it would rather show a logo or a sleeve.

**The surfaces read one ladder, each at its own rung.** Every label read resolves `image_key` + `image_updated_at` → a URL and leads with it over the cover. The reads emit the `large` (640) rung — the album/artist DTO contract — and a surface takes it down where its footprint is smaller:

- `/labels` cards — `listLabelsHubPage` returns `logoImageUrl`; the card renders `logo ?? cover`, **both** at `COVER_TILE_SIZE` (300), so the logo renders at tile size like every cover.
- `/label/<slug>` — `getLabelBySlug` returns `logoImageUrl`; the page's OG/social image is `logo ?? freshest cover ?? site cover` at `large`. The logo is **not** painted on the page (the masthead is the name, the bio, and the founding line), so it is a head-only asset and never a preload candidate.
- `/admin/labels` — the row plate is 44px, so it asks for `small` (64).
- Search — the label entity row leads with the logo over the cover subquery (`search.ts` carries `logo_key` + `logo_updated_at`).
- Hover card — a label's covers lead with its logo (`graph-preview.ts`), at the same `small` rung as the covers beside it.

**Wiring.** `backfill_label_images` → `POST /admin/backfill/label-images` (agent tier — internal, reversible, no publish; the `backfill_discogs` precedent), driven by `fluncle admin backfills label-images` (bounded + cursor-looping, `--dry-run` previews the worklist) both as the operator one-shot and as the recurring `fluncle-label-images` cron above.

A label logo is a **trademark shown to identify the label** — nominative use, the same posture as album art; it never implies endorsement.

## Label aliases (two spellings, one label)

`slugify` folds `Pilot.` and `Pilot`, but it cannot fold `Med School` and `Medschool` (they slug apart), and no normalizer gets `spiration music` → _Inspiration Music_ right on its own. The answer is a committed **alias map** where a second authority proposes and the operator confirms: the **`label_aliases`** table (the `artist_socials` precedent), one row per alternate spelling.

| Column       | What it is                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `label_id`   | The CANONICAL label this alias belongs to. An alias is another spelling OF a label, never a label of its own.      |
| `alias`      | The raw alternative spelling (Apple's `recordLabel`, an operator's typing).                                        |
| `alias_slug` | `slugify(alias)`, **indexed** — the join key the resolution wiring reads by.                                       |
| `source`     | `operator` \| `apple` \| `musicbrainz` \| `discogs` \| `spotify`. `apple` is the current writer.                   |
| `kind`       | `name` (a corroborated alternate spelling) or `hint` (a weaker lead — Apple names a label we don't yet recognise). |
| `status`     | `candidate` (awaiting the operator) or `confirmed` (ruled the same label). Reject deletes the row.                 |

**Where candidates come from (the ISRC anchor doing real work).** Apple's album `recordLabel` (stored on `albums.record_label_raw`) is a real second label authority — but ISRC identity alone does NOT clean it, because Apple's `recordLabel` is very often the DISTRIBUTOR, not the imprint. So `scripts/backfill-label-aliases.ts` (a deploy-time derivation over the stored album facts — it derives, it never remembers) applies two guardrails before writing a candidate:

1. **A distributor denylist** (`src/lib/label-distributors.ts`, operator-extendable: Believe, The Orchard, FUGA, …). A denylisted `recordLabel` is dropped — never a candidate.
2. **Cross-source corroboration.** Apple's `recordLabel` becomes a `candidate` (`kind: name`) only when it **fold-agrees** (`labelFold`) with the MusicBrainz label the crawled row already carries — the same recording, two independent authorities agreeing over the ISRC. If its slug already equals the canonical label's, there is nothing to alias. A lone Apple string that fold-agrees with no known label is a `hint` on the album's dominant label.

`tracks.label` is never rewritten (the immutable rail) and `labels.name` is never auto-changed (operator display authority); the derivation only proposes rows.

**Resolution (the re-mint trap this closes).** `tracks.label` is immutable, so a raw string whose spelling an operator has folded into another label would, on the next `ensureLabel` or deploy `reconcileLabels`, **re-mint its own slug as a NEW label — un-doing the fold every deploy.** So both consult CONFIRMED aliases (`status = 'confirmed'`, by `alias_slug`) BEFORE minting: `ensureLabel` adds one indexed read and returns the canonical id (the crawler reaches this same choke point); `reconcileLabels` and the deploy backfill (`scripts/backfill-labels.ts`) preload the confirmed-alias set once and skip re-minting any slug in it, linking those tracks to the canonical label instead. `apps/web/src/lib/server/labels.test.ts` reproduces the re-mint and proves it closed.

**And SEARCH reads the same fold.** A confirmed alias is a jump target and a filter, not just a minting guard: the entity tier resolves a label through `label_aliases` exactly as it resolves an artist through `artist_aliases`, and a `label` filter whose slug seek misses falls back to the very same `resolveConfirmedAliasLabelId` this section describes — so a spelling merged away still reaches the label that absorbed it. `confirmed` only, and the hub/count gate still decides inclusion. See [search](./search.md#and-so-does-a-label).

**The operator surface** is a review section on `/admin/labels` — **deliberately a page section, NOT a new attention-queue source.** Alias candidates are crawl-volume, and `label-review` is capped at 25 (`LABEL_REVIEW_QUEUE_LIMIT`) precisely because an uncapped crawl-volume source drowns the other five; spelling curation steers nothing and blocks nothing, so it stays low-priority background work off the queue. Each candidate shows the spelling, its provenance (Apple, matched to MusicBrainz vs Apple only), and **Fold it in / Not a match** (the operator-tier `confirm_label_alias` / `reject_label_alias` ops).

**Public visibility.** A `confirmed` alias joins the `/label/<slug>` page's `Organization` JSON-LD as `alternateName`, so a crawler that knows the imprint under either spelling lands on the same entity; `candidate`/`hint` aliases stay admin-only.

The album entity inherits the same class of collision (two records that share a name fold into one page); its disambiguation is the same map, run the other way. See [docs/album-entity.md](./album-entity.md#the-known-limit-two-records-one-name).

## Merging a slug-split label (the operator cleanup)

Aliases stop a split going FORWARD; `merge_label` cleans up the PRE-EXISTING ones — two `labels` rows that already mean one label because their spellings slugged apart before an alias caught them (the Med School / Medschool class). The operator runs `fluncle admin labels merge <losingSlug> <canonicalSlug>` (operator tier, `POST /api/v1/admin/labels/{slug}/merge`), folding the LOSING row into the CANONICAL one in a single transaction. `mergeLabel` in `apps/web/src/lib/server/labels.ts` does the work; a merge is proven by the harness in `labels.test.ts`.

A merge repoints every label foreign key, including `tracks.label_id`, `labels.parent_label_id`, and `label_aliases.label_id`. `albums` carries no label FK — its label edge is derived at read time from the raw string, so there is nothing to re-point there. The `crawl_frontier` queue keys by label SLUG, not by id, and is transient resumable state, so it is deliberately outside this id-FK re-point.

Identity and founding facts use canonical-wins semantics: retain an existing canonical value and fill only empty fields from the losing row.

**`seed_state` resolves by `ruled_at` precedence, and stops and asks on a real conflict.** The more recent operator ruling wins. But when BOTH rows carry a non-null `ruled_at` AND their seed states disagree, the op REFUSES with a 409 (`merge_seed_conflict`) telling the operator to re-rule one to match first — it never silently picks a side.

**The losing name becomes a confirmed alias, and the losing slug 301s.** The loser's display name lands in `label_aliases` as `confirmed` (source `operator`) before the loser row is deleted, so the immutable `tracks.label` free-text can never re-mint the merged-away slug on a later deploy backfill (the same re-mint guard U2a closed, `ensureLabel`/`reconcileLabels` consult confirmed aliases). The `/label/<slug>` loader then reads that confirmed alias (`resolveLabelAliasRedirect`) and 301s the merged-away slug to the canonical page — no new table, and the sitemap already carries only rows in `labels`, so deleting the loser drops it from the sitemap too. Both slugs' edge-cached pages are purged on the merge.

## Label lineage: founding facts + the imprint hierarchy

A label carries four more facts once the lineage sweep walks it: **`founding_date`** (MusicBrainz's `life-span.begin`, stored verbatim — a bare year "1996" or a full date "1996-04-29", never re-formatted), **`founded_location`** (its `area.name` — "London", "United Kingdom"), **`disambiguation`** (MusicBrainz's disambiguation comment — "UK drum & bass label" — the field MB writes when a name is not unique), and **`parent_label_id`** (the imprint it is a sublabel of). The first three are plain columns; the fourth is the interesting one.

**`disambiguation` is OPERATOR-facing, and it is free.** It rides the DEFAULT `/label/<mbid>` response the sweep already fetches for the life-span, so keeping it costs no extra call. It exists to answer "**which** Helix?" on the `/admin/labels` ruling row and appears nowhere public — the `/label/<slug>` page never speaks it. MusicBrainz sends `""` for the many labels it never had to disambiguate, so an empty comment is stored as NULL rather than verbatim. Every lineage write is `coalesce(column, ?)`, so a re-walk can never clobber a value already on the row. **Backfilling it for already-walked labels** is deliberately not an unbounded re-walk (`disambiguation is null` is the normal state, so that worklist would never drain): re-stale the lineage state instead — `update labels set lineage_state = 'pending', lineage_attempted_at = null where lineage_state = 'resolved'` — and let the existing hourly sweep walk them once.

**The parent edge is a self-reference, and that is the smallest honest model.** MusicBrainz models the imprint hierarchy with label-label relationships — `label ownership` and `imprint`. Walking a label with `inc=label-rels`, its parent appears with `direction: "backward"` (verified against real data: Med School → Hospital Records is a `backward` `label ownership`; Hospital Records → M*A*S*H is a `forward` `imprint`). A label has one parent in practice, so a single `parent_label_id` captures it, and the **SUBLABELS are the reverse read** (`where parent_label_id = ?`, the indexed `labels_parent_label_id_idx`) — so both `parentOrganization` and `subOrganization` come off one column, no relationships table. The sweep **never mints a label** from this path: a parent MusicBrainz names that no `labels` row already carries by MBID is only counted in the summary (`unmatchedParents`), never created — the operator mints it by that MBID (`mint_label`) or crawls it into existence the normal way, or it stays uncounted.

**A DEDICATED sweep, not a rider on the label-image sweep.** The image sweep is terminal per label (a resolved/none label is never re-walked), so a label whose logo already resolved would never get its lineage. Lineage carries its OWN state machine — `lineage_state` (`pending`/`resolved`/`none`) + `lineage_attempted_at` + `lineage_failures`, the label-images reliability triple cloned — so it reaches EVERY label, existing and crawler-minted, exactly once. It reuses the machinery it can: the shared 1 req/s MusicBrainz client and the exact-fold identity search (`searchMbLabelId`, so the two sweeps resolve a label's MBID the same way). Worker-paced (`backfill_label_lineage`, agent tier), one bounded batch per tick, circuit-broken on a throttle — the `fluncle-recording-mbids` shape. The durable poller is the hourly **`fluncle-label-lineage`** host timer (rave-02 — [docs/agents/hermes/label-lineage-timer/](./agents/hermes/label-lineage-timer/README.md)); registered as `cron.label-lineage` in `@fluncle/registry` + the healthcheck prober, box enable operator-gated, the repo half ships here. `lib/server/label-lineage.ts`.

**Emitted.** On `/label/<slug>` the `Organization` gains `foundingDate`, a `location` `Place` node, and `parentOrganization` / `subOrganization` `@id` edges to the related label pages' `#organization` nodes (both directions where derivable, omit-when-absent) — so a crawler reconciles the imprint hierarchy to one graph, the album→label `recordLabel` edge's shape one entity over. The visible page shows one quiet reference-register line beneath the bio — **"Founded 1996 · London"** (the dossier register: date + place, date alone, or the bare place), the year shown even when the stored date is fuller.
