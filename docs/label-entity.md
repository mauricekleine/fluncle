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

**A label with no finding has no public page.** It 404s. This is the label's read-side payment of the album's write-side rule — _an entity earns a public page because Fluncle FOUND something on it_ — and the label cannot pay it on the write side, because the crawler MUST mint a row for every imprint it discovers: that `undecided` row is the ruling queue. So the row exists, the operator rules on it, and the public sees nothing until a finding lands. The rule and the measurement behind it are in [album-entity.md](./album-entity.md#the-catalogue-deepens-a-page--it-never-creates-one): **the catalogue deepens a page, it never creates one.**

That also bounds the `label-review` queue: `listLabelReviewRows` hands the attention queue a WORKING SET (`LABEL_REVIEW_QUEUE_LIMIT`, oldest-first), because a wide crawl proposes hundreds of imprints and an uncapped source would drown the other five in the `/admin` cockpit, in its SSR payload, and in `fluncle admin queue`. `/admin/labels` remains the station where the full list is ruled on.

## Follow-ups

- **The alias map** — `spiration music` is a truncation of _Inspiration Music_; `1991` is a label named like a year. No normalizer gets these right. A committed alias map (fold + edit-distance proposes, the operator confirms) is the eventual answer, and it now covers **both** entities: the album entity inherits the same class of collision (two records that share a name fold into one page). See [docs/album-entity.md](./album-entity.md#the-known-limit-two-records-one-name).
