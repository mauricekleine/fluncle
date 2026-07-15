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

## How a row gets minted

Two idempotent write paths, and — unlike the first cut — the album is now a **catalogue-scale entity**, minted like `labels` rather than only off a finding:

1. **The publish path** — `publishTrack` calls `linkTrackToAlbum` / `linkTrackToLabel`, minting the entity off a certified finding (folded on the **slug**) and stamping the track's pointer. Best-effort and purely additive, so a failure never blocks an add.
2. **The catalogue crawler, INLINE** — `expandRelease` calls `ensureAlbum(name, releaseGroupMbid)` for every release it walks, folding the album on the **MusicBrainz release-group MBID** (the stable identity over a record's pressings; the slug is the fallback when MusicBrainz has no release group), then stamps `album_id` on the tracks it just wrote. So a crawled record earns its album entity off the bat — the crawler is to albums what it already is to labels.

The old **deploy-time reconcile** (`scripts/backfill-albums.ts` in `db:backfill`) is gone: the album edge is written inline now, so there is nothing to reconcile on every push. Its one-off descendant, `scripts/backfill-album-graph.ts`, is **operator-run once** to catch history up (mint off findings + link existing catalogue tracks by slug); it is in no deploy step. A legacy album row carries a `NULL` `release_group_mbid` until the running crawler's **adopt** path fills it — the next time it walks a release in that group, `ensureAlbum` resolves the album by slug and stamps the mbid in (fill-empty-only), so the fold-on-mbid self-heals through the live crawler rather than a one-shot MusicBrainz sweep.

What this changes, and what it does **not**:

- **The `albums` TABLE now grows with the catalogue** — one row per crawled release group, exactly as the crawler mints a `labels` row per discovered label (there are simply far more albums than labels). The old "mint only off a finding" bound is retired for albums.
- **The `/albums` EDITORIAL index stays archive-bounded.** `listAlbumsWithFindingCounts` is findings-joined, so the hub still lists only records Fluncle has certified something on — it does not swell to catalogue size.
- **Discovered albums now get pages**, exactly as discovered labels do: a findings-free record reaches `/album/<slug>` through the thin-content gate on total renderable tracks (below). The rule that "discovered labels get pages and discovered albums do not yet" no longer holds — closing that gap is what this slice did.
- **The quieter rows are unchanged in spirit.** An uncertified track on a record with an album row appears on that record's page; the crawled TRACK still earns no coordinate, no `/log` URL, and no name — the unnamed tier is intact.

## The public surfaces

**`/album/<slug>`** and **`/albums`** (with **`/label/<slug>`** and **`/labels`**) mirror `/artist/<slug>` exactly: a plate masthead, a cover-led grid of findings, the artists as chips, an `@id`-bearing JSON-LD entity, and the same thin-content gate. The album page carries one edge the label page has no twin for: **the album → label uplink**, rendered as a link and stamped into the `MusicAlbum` JSON-LD as `albumRelease.recordLabel`, pointing at the label page's `Organization` `@id`. That is where the graph closes.

### An entity earns a page on its CONTENT, not on Fluncle's

A graph page exists as soon as the entity does. A label the crawler discovered and Fluncle has certified nothing on **still has a `/label/<slug>` page**, and a label with 700 crawled releases and zero findings is a genuinely useful one — an honest record of what that label put out. Refusing to serve it throws away the entire point of having crawled it.

This reverses the rule that shipped first ("zero findings ⇒ the page 404s"). That rule was aimed at a real bug and hit the wrong target. Measured against a 10,800-row synthetic catalogue, **eight discovered-label pages were live and indexable**, and each one was a wall of Spotify outlinks under the heading _"Nothing logged off this one yet."_ That is a doorway page by Google's own definition — but what makes it one is the **hollow rendering**, not the page's existence. A page whose stated subject is a thing that is not on it is a doorway; a page that is honestly about the tracks it carries is a page.

**So the page stays, and the hollow rendering goes.** Every band on a graph page is **conditional**: it renders only when it has content, and renders _nothing_ — no heading, no empty state, no apology — when it does not. No findings ⇒ no findings section, and no "nothing logged yet" line in the masthead either. The page is then simply about what it has. The rule, and it is the load-bearing one:

> **A section renders only when it has content. A heading over an empty band is how a real page turns into a doorway page.**

What keeps a **stub** out of the index is the thin-content gate below, and it counts **total** renderable tracks, never findings — because a page is thin or not thin on what it _renders_, never on who wrote it.

**The rows are bounded — and at catalogue scale they are also GROUPED.** The seek is always indexed, so the SCAN is bounded however big the catalogue gets; the RESULT SET is what bit. On a 10,800-row catalogue an uncapped `/label/hospital-records` served **4.34 MB of HTML** — 3,000 rows through the markup, again through the hydration payload, a third time as `MusicRecording` JSON-LD. A flat cap fixed the bytes but left a wall: a crawled label with 700 releases from 30 artists is a discography, and a flat list of it is a dump, not a page. So the two big pages are **grouped**, and the bound moves with the grouping rather than disappearing (`lib/server/catalogue-groups.ts`):

- **`/album/<slug>`** is one record, so it stays the flat tracklist it always was — at most `GRAPH_PAGE_CATALOGUE_LIMIT` (100) quieter rows, newest release first, the true total counted in SQL (`count(*) over ()`) for the gate.
- **`/artist/<slug>`** groups its quieter rows into **records** (album name + tracklist); **`/label/<slug>`** groups them **by artist**, with record sub-sections inside each. The bound becomes a **page of groups** — at most `GRAPH_GROUP_PAGE_SIZE` (12) groups, ordered and windowed in SQL with a crawlable `?page=N` pager for the rest — plus a **per-group row cap** (`GRAPH_GROUP_TRACK_LIMIT`, 20, via a `row_number()` window), so one prolific artist cannot blow the page's budget and a group that hits the cap links to its own page for the rest. The hard ceiling is `GRAPH_GROUP_PAGE_SIZE × GRAPH_GROUP_TRACK_LIMIT` rows, by construction, whatever the label's size. Everything aggregates and ranks in SQL — grouping 30,000 rows in the isolate is exactly the OOM shape AGENTS.md forbids. Each group **collapses by default** (a Shadcn Accordion whose panel carries `hidden="until-found"`, so the collapsed rows stay in the server-rendered DOM — crawlable and find-in-page-able — while the page reads as a map, not a wall). Sort is alphabetical (default, stable under a growing crawl) or by release date; `tracks.release_date` is nullable and **undated sorts last** under both, never silently dropped. A group **heading names a real entity** (a record, an artist) — never the tier, which has no public name; the nameless bucket (tracks whose record is unknown) renders as bare rows with no heading at all. The pager's canonical is self-referencing per page but sort-collapsing (`?page=2`, never the sort param), so order-variants of one page do not dilute each other.

**And the crawled TRACK still earns nothing.** The rail that did not move: a `tracks` row with no `findings` row is not a finding, has no coordinate, and never gets a `/log` URL. The catalogue can grow without bound and the number of findings in the sitemap does not move. What a crawl now earns is a page for the **entity** its tracks hang off — never a page for a track.

### The findings lead, and the rest has no name

Every graph page renders **findings first, as findings** — the cover grid, each cover a link to its `/log/<coordinate>` page.

Beneath them sit the **quieter rows**: tracks Fluncle knows of but has never certified — a `tracks` row with no `findings` row, the same definition [The Ear](./the-ear.md) ranks by. The Ear is that tier's OPERATOR lens (`/admin/catalogue`, ranked by nearness to a finding); these rows are its PUBLIC face, and the two never share a name, because in public it has none. They are governed by one rule, and it is operator-ratified:

> **The tier has no public name.** It is never introduced, never named, never given a noun, and never counted aloud. There is no heading above those rows and there must never be one. "Finding" remains the only named object in Fluncle's world, and the word "catalogue" never appears in public copy.

Visually they are held apart by the **unlit register** (DESIGN.md): no cover and no coordinate (they have none), Stardust ink, a hairline rule as the only separator, and **no gold at rest or on hover** — so a hovered unlit row can never be mistaken for a focused one, and the One Sun budget survives a list that could run to dozens of rows. Focus, and only focus, is loud: the canonical Eclipse-Glow ring. A row links **out** to Spotify (a track with no Log ID has no page here to link to); one with no streaming presence at all renders as plain, unlinked text.

An **empty set renders nothing at all** — not an empty state, not a heading with no rows. That is true of **every** band on the page, not just this one (see _An entity earns a page on its content_ above): the findings grid, the artist chips, and the quieter rows all return nothing when they are empty, and the masthead drops its voice line when there is no finding to speak about. It is what lets one component set serve both a page Fluncle has certified ten bangers off and a page the crawler discovered, without either apologising for the half it does not have.

Accessibility gets an `aria-label` on the list (`More tracks on <entity>`), because an unlabelled list of links is an accessibility failure. It names the **tracks**, never the tier.

### The thin-content gate

A page indexes (and enters the sitemap) only past **`ALBUM_INDEX_MIN_TRACKS` / `LABEL_INDEX_MIN_TRACKS` = 3 renderable tracks** — its findings **plus** the quieter rows, because both are real content on the page. Below it the page still serves 200 (deep links, link equity) but is `noindex, follow` and stays out of the sitemap.

**It counts TOTAL content, never findings.** That is the whole point: it is the one gate, and it is the gate that replaced the 404. A label with two crawled rows and nothing else is a stub and stays out of the index; a label with 900 is a page and goes in. Neither answer depends on whether Fluncle has certified anything, because _the crawler's rows are content too_.

The gate counts the entity's **true** catalogue total, never the rendered 100-row slice — a 3,000-row label and a 100-row one must not read as the same page to it.

**Why the floor is 3, and not higher.** Three is low for a _catalogue-only_ page, and it is tempting to raise it — but the floor is shared with pages that carry real findings, and raising it would demote them. `/label/medschool` has 3 findings today: three coordinates, three notes, three covers, Fluncle's voice frame. That is unambiguously a page, and any floor above 3 silently `noindex`es it. Weighting a finding heavier than a crawled row would let both bars rise, but that reintroduces "who wrote it" into a gate whose entire job is to ask "what is on it" — so the floor stays 3 and stays honest. If a harder bar for catalogue-only pages is ever wanted, it is a _weighted_ gate and a deliberate decision, not a bump to this constant.

The threshold matches `ARTIST_INDEX_MIN_FINDINGS`'s value; what differs is WHAT is counted, and that is deliberate: **an album Fluncle found one banger on is a thin page today and a genuine tracklist page once the rest of the record is there.** Today every album in the archive is a single, so no album detail page clears the floor — the gate is working, not broken. The hubs (`/albums`, `/labels`) are listed unconditionally, like `/artists`: a hub's content is the whole list, so the per-page gate says nothing about it.

### The sitemap carries every page; the hub carries Fluncle's

The two lists answer different questions, and once a page can exist on crawled content alone they stop being the same list.

- **The hubs** (`/labels`, `/albums`) are **Fluncle's own** — _"every label I've pulled a banger off"_ — so they drive from the findings join (`listLabelsWithFindingCounts`). A label he has certified nothing on is absent, and would be a lie if it were there.
- **The sitemap** is the machine's **complete** map of pages that exist and may be indexed, so it drives from a different read (`listLabelSitemapRows` / `listAlbumSitemapRows`) that left-joins findings and applies the thin-content floor **in SQL**. A crawler-discovered label past the floor is in it.

The floor is applied in SQL rather than in the isolate on purpose: a wide crawl mints a `labels` row per label it walks past and most will sit on one or two rows, so filtering in TypeScript would drag every stub across the wire to throw it away (AGENTS.md — never rank or filter a growing table in the Worker).

Both halves of the invariant hold, and the same constant computes both sides: **an indexable page is never orphaned from the sitemap, and the sitemap never points at a page that is not there.**

## The known limit: two records, one name

Slug identity folds `Wormhole` and `wormhole` into one album, which is what we want. Run the other way, it also folds **two different records that share a name** into one — the `Pilot.`/`Pilot` fold, inverted. No normalizer gets this right, and it is not a normalizer's job.

The answer is the **alias map** `label-entity.md` already records as the eventual fix for both entities (a fold + edit-distance proposes; the operator confirms). Until it exists, the failure mode is a shared page rather than a wrong one, and the page still names every artist and label on it.

## The ops

There are none. The album entity has **no admin surface and no API op** — nothing about a record is an operator decision, and the public pages are SSR loader-driven (the `/artist/<slug>` precedent: a public route is loader + `useLoaderData`, no react-query, no oRPC).

The album's (and artist's) **cover art** is its own concern — an owned ≤1200²-capped master in Fluncle's R2, served through Cloudflare Images, best-source-wins. That is [docs/album-artwork.md](./album-artwork.md), not this doc.

The server layer lives in `apps/web/src/lib/server/albums.ts`; the label half in `labels.ts`. The entity-scoped track reads split by shape: the findings grid (`getFindingsBy*`, through the `FINDINGS_FROM` inner join) and the album page's flat quieter tracklist (`listCatalogueTracksByAlbum`, through the anti-join's exact complement) live in `tracks.ts`; the artist- and label-page **grouped** reads (`listArtistCatalogue`, `listLabelCatalogue`) live in `catalogue-groups.ts`, which owns the grouping, the per-group cap, and the pager bound. A crawled track is folded into the artist half of the graph by `linkTracksToArtistEntities` (`artists.ts`) — mint the entity only off a finding, then link every track, the same `album_id`/`label_id` rule — so `/artist/<slug>` reads its catalogue by an indexed `track_artists` seek rather than a full `artists_json` scan.
