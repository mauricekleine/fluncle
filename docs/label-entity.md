# The label entity

Fluncle keeps a canonical **label entity** (`labels`, keyed on the slug), and hangs one operator control off it: **which labels the future catalogue crawler may seed from.** Both halves now exist: the public `/label/<slug>` + `/labels` pages, and the operator's control surface.

The label is the third node of the graph the archive is becoming — **log ↔ artist ↔ label ↔ album**. Its structural twin, the album, is documented in [docs/album-entity.md](./album-entity.md), which also carries what the two share: the graph pointer on `tracks`, the mint-only-off-a-finding rule, the public page's shape, the unnamed quieter rows, and the thin-content gate. Read that doc for the page; this one owns the crawl-seed ruling.

## The data model

`tracks.label` stays exactly what it has always been: **the raw string Deezer handed back on the add**, free text, never rewritten. It is the audit trail and the re-normalization input. The `labels` table is its normalized twin, related by slug:

```
slugify(tracks.label) = labels.slug
```

That fold is what makes `Pilot.` and `Pilot` one label without a destructive rewrite of the findings. `tracks` also carries an indexed **`label_id` pointer** at the row — added with the public pages, which read by it (a seek, never a fold over the catalogue). It is an addition, not a replacement: `tracks.label` stays the raw captured string forever. See [docs/album-entity.md](./album-entity.md#the-graph-pointer-tracksalbum_id--trackslabel_id).

| Column       | What it is                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `slug`       | The identity and the join key (unique). Minted by `slugify(name)`.                                       |
| `name`       | The display name — the first raw spelling seen for that slug.                                            |
| `seed_state` | `enabled` \| `disabled` \| `undecided`. **Crawl scope, never storage** (below).                          |
| `ruled_at`   | When a HUMAN last ruled. NULL = no operator has ruled it (a machine default, or the one-time bootstrap). |

A label's finding count is **derived** (`GROUP BY tracks.label`, folded by slug), never stored — the denormalization-drift class is deleted outright, as with galaxy member counts.

## Crawl scope, never storage

This is the ruling, and it is the whole point of the control. **`seed_state` answers exactly one question: may the future catalogue crawler seed from this label?**

- **`disabled`** removes the label from the **next** crawl's seed set. It touches **nothing already stored** — no deletion, no hiding, no retroactive effect on tracks, on findings, or on anything a previous crawl already brought in. A disabled label's findings keep rendering exactly as they did before, and its finding count keeps counting them.
- **`enabled`** means the next crawl may dig from it.
- **`undecided`** is where a brand-new label enters: **never silently crawled, never silently dropped.** It surfaces in the `/admin` attention queue until a human rules on it.

"What we crawl FROM" and "what we KEEP" are separate concepts, and they stay that way in the code: no read anywhere joins `seed_state` to a decision about what is shown, kept, or deleted, and none ever should. `apps/web/src/lib/server/labels.test.ts` pins this with a test that disables a label and asserts the `tracks` table comes out byte-identical.

## How a label gets a row

Automatically, two ways, both idempotent:

1. **The publish path** — `publishTrack` calls `ensureLabel(deezer.label)` right after it upserts the artist entity. Best-effort and purely additive (one `labels` row, nothing else), so a failure never blocks an add.
2. **The deploy-time reconcile** — `scripts/backfill-labels.ts` runs as part of `db:backfill` in `deploy:cf`, ensuring a row exists for every distinct `tracks.label`. The self-healing backstop.

An existing label is never clobbered: its seed state, its ruling stamp, and its display name all survive.

## The starting ruling (the one-time bootstrap)

`scripts/backfill-labels.ts` also carries the operator's **starting ruling** (the-archive RFC, D7), applied **exactly once**, gated on a `labels_seeded_at` marker in the `settings` table:

- **Skipped** (crossover-remix imprints, not drum & bass): Anjunabeats, Armada Music, Axtone Records, Positiva, Tomorrowland Music / Experts Only, Atlantic Records UK, Counter Records, Zerothree.
- **Undecided** (the operator's call, pending): Chelou, spiration music, UKF (a channel brand rather than a label proper — seeding from it would cast a very wide net).
- **Enabled**: everything else in the archive at the moment the entity landed.

It is a **one-time data step, not runtime logic** — nothing in the Worker reads those lists, and once the marker is stamped the step never runs again. A label added tomorrow enters `undecided` and waits for a human, like any other. It also refuses to touch a row an operator has already ruled on (`ruled_at IS NOT NULL`), so a re-run cannot overrule a human.

## The surfaces

**`/admin/labels`** is the management station (sidebar: Labels, beside Artists). Sections in the order the work arrives: _Waiting on a ruling_ (the queue), then _Seeding from_, then _Not seeding_. An unruled row's two ruling buttons are the loudest thing on the page (the disclosure law); re-ruling a settled label is the rare act, behind the row's `⋮`.

**The attention queue** carries `label-review` as a source (`apps/web/src/lib/attention.ts`): every `undecided` label is one row, oldest-first, deep-linking to `/admin/labels`. It never rides the deadline tier — a ruling steers the next crawl and blocks nothing.

## The ops (`packages/contracts/src/orpc/admin-labels.ts`)

| op                  | tier                       | path                       |
| ------------------- | -------------------------- | -------------------------- |
| `list_labels_admin` | admin (agent-allowed read) | `GET /admin/labels`        |
| `update_label`      | operator                   | `PATCH /admin/labels/{id}` |

`list_labels_admin` takes an optional `seedState` filter, and **`?seedState=enabled` is the seed-set read**: when the catalogue crawler exists, that is where it asks — with its agent token — what it may seed from. Nothing consumes it yet. The `_admin` suffix (the `list_galaxies_admin` precedent) keeps the public `list_labels` / `get_label` names free for the coming `/label/<slug>` pages.

`update_label` is operator tier: ruling steers what Fluncle crawls next, which is an editorial act, so an agent token 403s at `operatorGuard` (the `update_galaxy` precedent). Both are enforced by the build-fail coverage tests (`orpc-auth-coverage`, `orpc-naming`).

The server layer lives in `apps/web/src/lib/server/labels.ts`.

## The public page

`/label/<slug>` (and the `/labels` index) shipped with the album entity, and its shape is documented once, in [docs/album-entity.md](./album-entity.md#the-public-surfaces): findings first, the artists as chips, the unnamed quieter rows beneath them, an `Organization` JSON-LD node whose `@id` is the page URL, and the renderable-track thin-content gate.

Two things worth restating here, because both are about this entity specifically.

**The public page is blind to `seed_state`.** A label the operator skipped for the crawler renders exactly as it always did, and its findings keep counting. Crawl scope, never storage — no read behind the page knows the column exists.

**A label with no finding still has a public page.** A label the crawler discovered and Fluncle has certified nothing on gets a `/label/<slug>` page built from its crawled releases, and that is deliberate: a discography is a real page. It briefly 404'd instead, on the rule _"the catalogue deepens a page, it never creates one"_ — that rule is **reversed**, and the reasoning is in [album-entity.md](./album-entity.md#an-entity-earns-a-page-on-its-content-not-on-fluncles). The short version: the doorway page was never the page's _existence_, it was the **hollow rendering** (a _"Nothing logged off this one yet."_ heading above a wall of outlinks), so the fix is **conditional sections** — no findings, no findings section, no apology — plus a thin-content gate on **total** content that keeps a two-row stub out of the index.

One consequence worth naming, because the two lists now differ: **`/labels` is narrower than the sitemap.** The hub is Fluncle's own list (_"every label I've pulled a banger off"_) and stays findings-joined; the sitemap is the machine's complete map and carries the crawler-discovered pages too. Neither is wrong; they answer different questions.

The crawl also bounds the `label-review` queue: `listLabelReviewRows` hands the attention queue a WORKING SET (`LABEL_REVIEW_QUEUE_LIMIT`, oldest-first), because a wide crawl proposes hundreds of labels and an uncapped source would drown the other five in the `/admin` cockpit, in its SSR payload, and in `fluncle admin queue`. `/admin/labels` remains the station where the full list is ruled on.

## The label's own image (its real logo, not a borrowed cover)

Every label surface — the `/labels` index cards, the `/label/<slug>` page (its OG/social image), the search entity row, the graph hover card — used to show **the freshest finding's album cover** as the label's picture. For most labels that is an arbitrary sleeve; only a label whose cover happens to carry its logo (Anjunabeats) read right. The fix gives a label its **OWN image**, and it is stored on the `labels` row:

| Column                                  | What it is                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `mb_label_id`                           | The MusicBrainz label MBID — the identity anchor. The crawler already resolves it at walk time and now persists it. |
| `discogs_label_id`                      | The Discogs label id (off the MB label's curated Discogs url-rel) — the source of the logo image.                   |
| `image_key`                             | The R2 object key of the stored logo (`labels/<slug>.<ext>`), served world-readable from `found.fluncle.com`.       |
| `image_state`                           | The resolve lifecycle: `pending` (the DDL default — every label enters the worklist), `resolved`, `none`.           |
| `image_attempted_at` / `image_failures` | The reliability pair (the shipped `backfill_*` convention): transient failures back off; a persistent one gives up. |

**Discogs is the source.** Labels are first-class on Discogs and `GET /labels/{id}` returns an `images[]` array with the real logo. The identity is reached the way `discogs.ts` already reaches releases — through **MusicBrainz's curated `url-rels`**, never through Discogs search — so the resolve walks: the label name → its MBID (`/label?query=`, exact-fold match, the crawler's `fold`) → `/label/<mbid>?inc=url-rels` → the Discogs (and Wikidata) relation. The logo is **downloaded once and stored in our own R2** (`env.VIDEOS`, behind `found.fluncle.com`) — Discogs is **never hotlinked**: their ToS forbids it and image requests need the authed token.

**The fallback ladder** (explicit, tested in `label-images.test.ts`):

1. **Discogs label image** — the primary source (`discogs.ts::fetchDiscogsLabelImage`, both calls authed + on the shared Discogs rate-limit gate).
2. **Wikidata P154 (logo image)** — off the MB label's Wikidata url-rel, via Commons `Special:FilePath`. The second rung: cheap, because the QID is already in the url-rels walked for Discogs.
3. **The floor** — no image anywhere: `image_state='none'`, and every surface keeps rendering **exactly what it renders today** (the freshest finding's cover). A tiny artist-run label with no Discogs/Wikidata image degrades gracefully, never to an empty card.

**The resolve sweep** (`label-images.ts::resolveLabelImages`) is a bounded, idempotent, **Worker-paced** pass — the shipped `fluncle-backfill` discipline: the box holds no vendor keys, so the MusicBrainz walk + the authed Discogs fetches happen in the Worker and the box `--no-agent` cron drives one small batch per tick (`MAX_BATCH` labels). MusicBrainz is the shared 1 req/s client; Discogs is the shared authed gate; both report `rateLimited` and the sweep **circuit-breaks** on it (stops the pass, retries next tick with a fresh window). A `resolved`/`none` label is terminal and skipped forever; a transient failure backs off on a cooldown; a persistent one gives up (→ `none`) so it is never retried forever. **Idempotent by construction** — a second run over a fully-resolved archive fetches nothing.

**The durable path (`fluncle-label-images`).** The catalogue crawler mints new labels every few minutes, each landing at `image_state='pending'` — so the resolve sweep must be a RECURRING poller, not a one-shot backfill. The **`fluncle-label-images`** host timer (rave-02, hourly — [docs/agents/hermes/label-images-timer/](./agents/hermes/label-images-timer/README.md)) drives one bounded batch per tick via the same `fluncle admin backfills label-images` op, so a freshly-minted label gets its logo within the hour instead of sitting `pending` forever. The crawl makes labels exist; this sweep gives each a logo — the same loop the crawler and The Ear's ranking form. Hourly is plenty: the crawl mints only tens of labels/day and Discogs' 1 req/s ceiling means there is no prize for hurrying; a tick over a drained worklist is a cheap no-op. It is registered as `cron.label-images` in `@fluncle/registry` + the healthcheck prober's `CRON_SPECS`, so it appears on `/status` on its first tick. Like the other agent sweeps the box enable is operator-gated; the repo half (scripts + timer + this doc) ships here.

**The surfaces read one ladder.** Each label read resolves `image_key` → a URL via `media.ts::labelLogoUrl` and leads with it over the cover:

- `/labels` cards — `listLabelsWithFindingCounts` returns `logoImageUrl`; the card renders `logoImageUrl ?? cover`.
- `/label/<slug>` — `getLabelBySlug` returns `logoImageUrl`; the page's OG/social image is `logo ?? freshest cover ?? site cover`.
- Search — the label entity row leads with `labels.image_key`'s URL over the cover subquery (`search.ts`).
- Hover card — a label's covers lead with its logo (`graph-preview.ts`).

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

**The operator surface** is a review section on `/admin/labels` — **deliberately a page section, NOT a new attention-queue source.** Alias candidates are crawl-volume, and `label-review` is capped at 25 (`LABEL_REVIEW_QUEUE_LIMIT`) precisely because an uncapped crawl-volume source drowns the other five; spelling curation steers nothing and blocks nothing, so it stays low-priority background work off the queue. Each candidate shows the spelling, its provenance (Apple, matched to MusicBrainz vs Apple only), and **Fold it in / Not a match** (the operator-tier `confirm_label_alias` / `reject_label_alias` ops).

**Public visibility.** A `confirmed` alias joins the `/label/<slug>` page's `Organization` JSON-LD as `alternateName`, so a crawler that knows the imprint under either spelling lands on the same entity; `candidate`/`hint` aliases stay admin-only.

The album entity inherits the same class of collision (two records that share a name fold into one page); its disambiguation is the same map, run the other way. See [docs/album-entity.md](./album-entity.md#the-known-limit-two-records-one-name).
