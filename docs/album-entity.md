# The album entity

Fluncle keeps a canonical **album entity** (`albums`, keyed on the slug) — the fourth node of the graph the archive is becoming: **log ↔ artist ↔ label ↔ album**. It is the structural twin of [the label entity](./label-entity.md); read that doc first, then this one for what differs.

What differs is mostly what is **absent**. A label carries an operator control (the crawl-seed ruling) because a label is a crawl seed. An album is not, so it has no `seed_state`, no `ruled_at`, no attention-queue row, and no `/admin/albums` station. There is nothing about a record for a human to decide.

## The data model

`tracks.album` stays exactly what it has always been: **the raw string the vendor handed back on the add**, free text, never rewritten. It is the audit trail and the re-normalization input. The `albums` table is its normalized twin, related by slug:

```
slugify(tracks.album) = albums.slug
```

| Column | What it is                                                         |
| ------ | ------------------------------------------------------------------ |
| `slug` | The identity and the join key (unique). Minted by `slugify(name)`. |
| `name` | The display name — the first raw spelling seen for that slug.      |

A record's finding count is **derived**, never stored — the denormalization-drift class is deleted outright, as with labels and galaxy member counts.

### The graph pointer (`tracks.album_id` / `tracks.label_id`)

Both entities now carry an **indexed pointer from `tracks`** (`album_id`, `label_id`), which is the follow-up `label-entity.md` recorded when the label entity landed. `tracks.album` / `tracks.label` stay the raw captured strings regardless — the pointer is an **addition, never a replacement**.

It exists because the PUBLIC page asks a question the admin surface never did. Folding slugs in TypeScript is fine over the FINDINGS join — that is bounded by how many tracks Fluncle has certified, a `GROUP BY` of tens of rows. But a graph page also asks _"every track on this record, including the ones Fluncle never certified"_, and answering that by folding the whole catalogue inside the Worker is exactly the shape AGENTS.md forbids (never scan or rank a growing table in the isolate). An equality on an indexed entity id is a seek, at any catalogue size.

`NULL` means "not linked": the track carries no album/label string, or its string folds to a slug no entity row exists for.

## How a row gets minted — and why only off a finding

Two write paths, both idempotent, and both seeded **only from certified findings**:

1. **The publish path** — `publishTrack` calls `linkTrackToAlbum` / `linkTrackToLabel`, which mint the entity and stamp the track's pointer. Best-effort and purely additive, so a failure never blocks an add.
2. **The deploy-time reconcile** — `scripts/backfill-albums.ts` (and the `label_id` half of `scripts/backfill-labels.ts`) run as part of `db:backfill` in `deploy:cf`. Two steps: **mint** every entity a certified finding carries, then **link** every track — certified or not — whose entity now has a row.

That an entity is minted **only off a finding** is the load-bearing rule, and it does two jobs:

- **It bounds the indexes.** An album earns an entity, a public page, and a sitemap slot because Fluncle FOUND something on it. Minting off a raw `tracks` scan would mint a row for every record Fluncle has merely heard of the moment the catalogue lands, and `/albums` would swell from an archive-sized list to a catalogue-sized one.
- **It decides what the quieter rows can contain.** An uncertified track on a record Fluncle found a banger on gets linked, so it appears on that record's page. One on a record he never touched stays unlinked, and is therefore invisible everywhere.

The **link** step is also the self-healing path by which a track written by any writer that knows nothing of these columns — an admin update, the future catalogue crawler — is folded into the graph on the next deploy.

## The public surfaces

**`/album/<slug>`** and **`/albums`** (with **`/label/<slug>`** and **`/labels`**) mirror `/artist/<slug>` exactly: a plate masthead, a cover-led grid of findings, the artists as chips, an `@id`-bearing JSON-LD entity, and the same thin-content gate. The album page carries one edge the label page has no twin for: **the album → label uplink**, rendered as a link and stamped into the `MusicAlbum` JSON-LD as `albumRelease.recordLabel`, pointing at the label page's `Organization` `@id`. That is where the graph closes.

### The catalogue DEEPENS a page — it never CREATES one

This is the rule that keeps the graph pages honest once a crawler is filling `tracks`, and it has two halves.

**A page needs a finding.** An entity carrying zero findings resolves as MISSING and `/label/<slug>` (or `/album/<slug>`) **404s**, however many crawled rows hang off it. The album already obeyed this as a WRITE rule — an `albums` row is minted only off a certified finding. A LABEL row cannot: the crawler has to mint one for every imprint it discovers, because the `undecided` row **is** the operator's ruling queue ([the widening loop](./catalogue-crawler.md)). So the label pays the same rule on the READ side instead, and both pages state it, and both are tested (`catalogue-scale.integration.test.ts`).

Without it, a wide crawl publishes one indexable page per discovered imprint whose entire content is a wall of Spotify outlinks under the line _"Nothing logged off this one yet."_ That is a doorway page by Google's own definition. It shipped: measured against a 10,800-row synthetic catalogue, **eight such pages were live and indexable**, and — because the sitemap's entity lists inner-join `findings` — **none was in the sitemap**, breaking the invariant this doc states below. Now the invariant holds in both directions: an indexable page is never orphaned from the sitemap, and **the sitemap never points at a page that is not there.**

**The rows are capped.** A page renders at most `GRAPH_PAGE_CATALOGUE_LIMIT` (100) quieter rows — the newest releases by date, not an arbitrary alphabetical slice — while the entity's TRUE total is counted in SQL (`count(*) over ()`) and is what the thin-content gate below keys off. The seek was always indexed, so the SCAN was always bounded; the RESULT SET was not, and that is the distinction that bit. On the same 10,800-row catalogue, `/label/hospital-records` served **4.34 MB of HTML** — 3,000 rows through the markup, again through the hydration payload, and a third time as `MusicRecording` nodes in the JSON-LD. Capped, the same page is **222 KB**.

### The findings lead, and the rest has no name

Every graph page renders **findings first, as findings** — the cover grid, each cover a link to its `/log/<coordinate>` page.

Beneath them sit the **quieter rows**: tracks Fluncle knows of but has never certified — a `tracks` row with no `findings` row, the same definition [The Ear](./the-ear.md) ranks by. The Ear is that tier's OPERATOR lens (`/admin/catalogue`, ranked by nearness to a finding); these rows are its PUBLIC face, and the two never share a name, because in public it has none. They are governed by one rule, and it is operator-ratified:

> **The tier has no public name.** It is never introduced, never named, never given a noun, and never counted aloud. There is no heading above those rows and there must never be one. "Finding" remains the only named object in Fluncle's world, and the word "catalogue" never appears in public copy.

The prohibition is on naming the **tier**, and here that means no heading at all: the block on a graph page is **homogeneous** — every row in it is uncertified — so any heading over it would be the tier's name by construction, whatever word it used. That is why the rule reads absolutely on this surface, and it still does.

Search is the one surface where the rule reads differently, and for a structural reason rather than a softer one: its list is **mixed**, ranking findings and uncertified rows together, so a heading there can name the **superset** without naming either kind (`Tracks` — the universal music object, of which a finding is a certification). The same instinct already lives on this page in the `aria-label` below: it names the tracks, never the tier. See [DESIGN.md](../DESIGN.md)'s Unlit Rule for the ratified test.

Visually they are held apart by the **unlit register** (DESIGN.md): no cover and no coordinate (they have none), Stardust ink, a hairline rule as the only separator, and **no gold at rest or on hover** — so a hovered unlit row can never be mistaken for a focused one, and the One Sun budget survives a list that could run to dozens of rows. Focus, and only focus, is loud: the canonical Eclipse-Glow ring. A row links **out** to Spotify (a track with no Log ID has no page here to link to); one with no streaming presence at all renders as plain, unlinked text.

An **empty set renders nothing at all** — not an empty state, not a heading with no rows. Today that is every page (the archive is entirely certified), so the band is simply dark until the catalogue lands.

Accessibility gets an `aria-label` on the list (`More tracks on <entity>`), because an unlabelled list of links is an accessibility failure. It names the **tracks**, never the tier.

### The thin-content gate

A page indexes (and enters the sitemap) only past **`ALBUM_INDEX_MIN_TRACKS` / `LABEL_INDEX_MIN_TRACKS` = 3 renderable tracks** — its findings **plus** the quieter rows, because both are real content on the page. Below it the page still serves 200 (deep links, link equity) but is `noindex, follow` and stays out of the sitemap. The sitemap filters on the same sum, so an indexable page is never orphaned from it.

The gate counts the entity's **true** catalogue total, never the rendered 100-row slice — a 3,000-row imprint and a 100-row one must not read as the same page to it.

The threshold is `ARTIST_INDEX_MIN_FINDINGS`'s value; what differs is WHAT is counted, and that is deliberate: **an album Fluncle found one banger on is a thin page today and a genuine tracklist page once the rest of the record is there.** Today every album in the archive is a single, so no album detail page clears the floor — the gate is working, not broken. The hubs (`/albums`, `/labels`) are listed unconditionally, like `/artists`: a hub's content is the whole list, so the per-page gate says nothing about it.

**So what IS a label with 1 finding and 700 catalogue tracks?** A real page, and it indexes. The floor it has to clear is not "3 tracks" — it is **1 finding**, which is what the 404 above enforces. Past that floor the catalogue is context, exactly as a discography table is context on a Wikipedia article: the page has an original coordinate, an original note, a cover, and Fluncle's own voice frame, and the quieter rows deepen it. Below that floor there is no page at all. The renderable-track sum stays as the SECOND gate — it is what lets a record fill out from single to tracklist — but it can no longer, on its own, conjure a page out of a crawl.

## The known limit: two records, one name

Slug identity folds `Wormhole` and `wormhole` into one album, which is what we want. Run the other way, it also folds **two different records that share a name** into one — the `Pilot.`/`Pilot` fold, inverted. No normalizer gets this right, and it is not a normalizer's job.

The answer is the **alias map** `label-entity.md` already records as the eventual fix for both entities (a fold + edit-distance proposes; the operator confirms). Until it exists, the failure mode is a shared page rather than a wrong one, and the page still names every artist and label on it.

## The ops

There are none. The album entity has **no admin surface and no API op** — nothing about a record is an operator decision, and the public pages are SSR loader-driven (the `/artist/<slug>` precedent: a public route is loader + `useLoaderData`, no react-query, no oRPC).

The server layer lives in `apps/web/src/lib/server/albums.ts`; the label half in `labels.ts`; the two entity-scoped track reads (`getFindingsBy*` through the `FINDINGS_FROM` inner join, and `listCatalogueTracksBy*` through its exact complement, the anti-join) in `tracks.ts`.
