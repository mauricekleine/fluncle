# The label entity

Fluncle keeps a canonical **label entity** (`labels`, keyed on the slug), and hangs one operator control off it: **which labels the future catalogue crawler may seed from.** The entity's public half (`/label/<slug>` pages) is not built yet; the control surface is.

## The data model

`tracks.label` stays exactly what it has always been: **the raw string Deezer handed back on the add**, free text, never rewritten. It is the audit trail and the re-normalization input. The `labels` table is its normalized twin, related by slug:

```
slugify(tracks.label) = labels.slug
```

That fold is what makes `Pilot.` and `Pilot` one label without a destructive rewrite of the findings. There is **no FK on `tracks`** and no `label_id` column — deliberately, for now (see _Follow-ups_).

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

## Follow-ups

- **The public `/label/<slug>` pages** — the entity is here; the pages are not.
- **`tracks.label_id`** — relating by slug is deliberate for now: a destructive FK migration on `tracks` is a separate, riskier change and was kept out of the entity's landing. `tracks.label` stays the raw captured string regardless (it is the audit trail); the FK would be an addition, not a replacement.
- **The alias map** — `spiration music` is a truncation of _Inspiration Music_; `1991` is a label named like a year. No normalizer gets these right. A committed alias map (fold + edit-distance proposes, the operator confirms) is the eventual answer, and it belongs with the public pages.
