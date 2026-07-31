# The album entity

Fluncle keeps a canonical **album entity** (`albums`, keyed on the slug) — the fourth node of the graph the archive is becoming: **log ↔ artist ↔ label ↔ album**. It is the structural twin of [the label entity](./label-entity.md); read that doc first, then this one for what differs.

What differs is mostly what is **absent**. A label carries an operator control (the crawl-seed ruling) because a label is a crawl seed. An album is not, so it has no `seed_state`, no `ruled_at`, no attention-queue row, and no `/admin/albums` station. There is nothing about a record for a human to decide.

## The data model

`tracks.album` is the immutable raw string captured from the vendor. The `albums` table is its normalized twin, related by slug:

```
slugify(tracks.album) = albums.slug
```

| Column | What it is                                                         |
| ------ | ------------------------------------------------------------------ |
| `slug` | The identity and the join key (unique). Minted by `slugify(name)`. |
| `name` | The display name — the first raw spelling seen for that slug.      |

A record's finding count is **derived**, never stored — the denormalization-drift class is deleted outright, as with labels and galaxy member counts.

**The Discogs release facts** (`discogs_catno`, `discogs_styles`, plus the `discogs_state`/`discogs_attempted_at`/`discogs_failures` ledger) come off the Discogs release a finding already resolves to (`tracks.in_release_id`): the label's own **catalogue number** and the release's **styles**. Both are RELEASE attributes, so they land at album grain for the reason `record_label_raw` does — a fact that varies per pressing is stored once per record, and the stored catno is the one from the pressing Fluncle actually resolved, representative rather than exhaustive. They arrive two ways and cost nothing extra: the resolver's scored-search leg already holds the payload it scored (captured inline, at publish and in `backfill_discogs`), and `backfill_discogs_facts` re-reads the release for the majority the MusicBrainz bridge resolved without ever fetching one. The worklist is album-grained and self-draining (`pending` → `resolved` | terminal `none`), so one lookup serves every finding on a record. **The catno is the only half that is public**, and it is public **only beside its label** — a quiet code after the `On <label>` uplink on `/album/<slug>`, introduced by no noun. `Label CATNO` is the record-shop convention and the label is what makes the code legible _as_ a code; a bare alphanumeric under an album title with no host is the unnamed tier being handed vocabulary, and since `getLabelForAlbum` resolves through the certification, a label-less record is precisely an uncertified one. So the visible number waits for its label while the MusicRelease JSON-LD's `catalogNumber` emits either way — a key named `catalogNumber` carries its own noun and needs no host. The styles are **store-only**, because a page whose genre is drum & bass by construction has no honest home for a style band, and inventing one would give the page vocabulary it has not earned.

### The graph pointer (`tracks.album_id` / `tracks.label_id`)

Tracks carry indexed `album_id` and `label_id` pointers for graph-page seeks. The raw `tracks.album` and `tracks.label` strings remain immutable normalization inputs.

It exists because the PUBLIC page asks a question the admin surface never did. Folding slugs in TypeScript is fine over the FINDINGS join — that is bounded by how many tracks Fluncle has certified, a `GROUP BY` of tens of rows. But a graph page also asks _"every track on this record, including the ones Fluncle never certified"_, and answering that by folding the whole catalogue inside the Worker is exactly the shape AGENTS.md forbids (never scan or rank a growing table in the isolate). An equality on an indexed entity id is a seek, at any catalogue size.

`NULL` means "not linked": the track carries no album/label string, or its string folds to a slug no entity row exists for.

## How a row gets minted

Albums are catalogue-scale entities minted through two idempotent paths: publishing links a certified finding, and `expandRelease` connects or creates the album by MusicBrainz release-group MBID, with the slug as fallback. `scripts/backfill-album-graph.ts` links rows that lack graph pointers. Catalogue-minted albums participate in the public graph while uncertified tracks remain in the unlit register.

## The public surfaces

**`/album/<slug>`** and **`/albums`** (with **`/label/<slug>`** and **`/labels`**) mirror `/artist/<slug>` exactly: a plate masthead, a cover-led grid of findings, the artists as chips, an `@id`-bearing JSON-LD entity, and the same thin-content gate. The album page carries one edge the label page has no twin for: **the album → label uplink**, rendered as a link and stamped into the `MusicAlbum` JSON-LD as `albumRelease.recordLabel`, pointing at the label page's `Organization` `@id`. That is where the graph closes.

### An entity earns a page on its CONTENT, not on Fluncle's

A graph page exists as soon as the entity does. A label the crawler discovered and Fluncle has certified nothing on **still has a `/label/<slug>` page**, and a label with 700 crawled releases and zero findings is a genuinely useful one — an honest record of what that label put out. Refusing to serve it throws away the entire point of having crawled it.

A graph page exists when its entity exists. Render each section only when it has content, and use the thin-content gate over total renderable tracks to keep stubs out of the index.

**So the page stays, and the hollow rendering goes.** Every band on a graph page is **conditional**: it renders only when it has content, and renders _nothing_ — no heading, no empty state, no apology — when it does not. No findings ⇒ no findings section, and no "nothing logged yet" line in the masthead either. The page is then simply about what it has. The rule, and it is the load-bearing one:

> **A section renders only when it has content. A heading over an empty band is how a real page turns into a doorway page.**

What keeps a **stub** out of the index is the thin-content gate below, and it counts **total** renderable tracks, never findings — because a page is thin or not thin on what it _renders_, never on who wrote it.

Graph-page result sets are bounded and grouped. Artist pages group by record; label pages group by artist with record subsections. SQL applies the group-page and per-group limits before rows reach the isolate.

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

### A recording renders once (the duplicate defence)

A single recording reaches the catalogue under **several barcodes** — the same track on the original single, a compilation, a reissue — so a naive tracklist renders _"20 Man Down"_ twice and _"Selecta"_ twice. The graph pages hold one row per **recording**, and they do it in two layers, both display-level (the rows still exist; they are just not both shown):

- **The stamped veto, in SQL.** Every catalogue read here (`listCatalogueTracksByAlbum`, and the grouped `listArtistCatalogue` / `listLabelCatalogue` reads in `catalogue-groups.ts`) drops any row an operator has marked `duplicate_of_track_id` or `dismissed_at`, alongside the finding anti-join — and drops it from the `count(*) over ()` total too, so the thin-content gate keys off the same set the page renders.
- **The render-time fold, in the isolate.** The crawler leaves most twins **unstamped**, so each page folds its bounded slice by recording identity — the shared `matchKey` from `track-match.ts` (`dedupeByRecordingIdentity`), the exact identity the Rekordbox matcher uses, so a remix or VIP is never folded onto the original but `(Original Version)` is. One representative survives per identity, chosen deterministically: the **Spotify-anchored** row wins, then an **ISRC**-bearing one, then the **newest** release, then the lowest id. The slice is bounded (≤ `GRAPH_PAGE_CATALOGUE_LIMIT`), so this is the few-hundred-row isolate fold AGENTS.md permits, never a scan. The total the thin-content gate reads is the folded count, so a page of ten barcodes of three recordings is a three-track page, not a ten-track one.

This is the render half only: it does not stamp anything or widen the catalogue's own duplicate graph (that heavier path — `readCatalogueIdentity`, the rank sweep — is deliberately not walked from a page load).

### The thin-content gate

A page indexes (and enters the sitemap) only past **`ALBUM_INDEX_MIN_TRACKS` / `LABEL_INDEX_MIN_TRACKS` = 3 renderable tracks** — its findings **plus** the quieter rows, because both are real content on the page. Below it the page still serves 200 (deep links, link equity) but is `noindex, follow` and stays out of the sitemap.

**It counts TOTAL content, never findings.** It is the single indexability gate. A label with two crawled rows and nothing else is a stub and stays out of the index; a label with 900 is a page and goes in. Neither answer depends on whether Fluncle has certified anything, because _the crawler's rows are content too_.

The gate counts the entity's **true** catalogue total, never the rendered 100-row slice — a 3,000-row label and a 100-row one must not read as the same page to it.

The floor is 3 because it is shared by catalogue-only and finding-bearing pages. Raising the unweighted threshold would exclude valid pages with three substantial finding records. A stricter catalogue-only policy requires a separate weighted gate.

### The sitemap carries every page; the hub is one unified index

`/labels`, `/albums`, and `/artists` are unified catalogue-scale indexes. Each lists every entity Fluncle holds in one alphabetical, `?page=N`-paginated surface.

A certified entity is distinguished **visually, never verbally** (DESIGN.md's Unlit Rule, extended): its NAME text takes the **certification light** (Eclipse Gold); an uncertified name keeps the plain ink. There is **no badge, no tier heading, no "N findings" caption** — the tile counts RENDERABLE tracks uniformly (_"N tracks"_, the superset noun) for every row. The gold is text, not a glow; hover carries a neutral Dust lift for every tile (no gold ever lands on an uncertified row) and only the focus ring stays canonical Eclipse. Certified entities are sparse per alphabetical page, so the One Sun budget holds.

The gate that admits a row is a disjunction: a **certified** entity is always in (`sum(certified) > 0`); an **uncertified** catalogue entity is in only when its page clears the thin-content floor (`renderable >= floor`) — the same floor the sitemap and the `/entity/<slug>` indexability gate use, so the three agree by construction. The scan is the proven grouped shape (a materialized CTE walked once for the total, the page slice, and the A–Z lane); the `certified` flag and the counts ride the PAGED rows, never a whole-table read into the isolate.

- **The sitemap** stays a **separate** read (`listLabelSitemapRows` / `listAlbumSitemapRows`): the machine's complete map of pages that exist and may be indexed, so it wants the WHOLE floor-clearing set at once (no `limit`/`offset`) and only the `slug` + `lastmod` a `<url>` needs. Same floor, different shape; the sitemap must never be paged to a page size, or it would omit every entity past the window and orphan its page. **An indexable page is never orphaned from the sitemap, and the sitemap never points at a page that is not there.**
- **One navigation model for humans and crawlers alike** — every page, page 1 included, SSRs one OFFSET slice of tiles behind a real-anchor `?page=N` pager (with an A–Z fast lane on `/labels` + `/artists`; `/albums` has none — a record's identity is its cover, not a title-initial), so every tile past the first page is a link a crawler follows, nothing depends on running JS, and the footer stays reachable at every catalogue size. A `?page=N` past the end is an honest empty page, and the route 404s off `page > pageCount` rather than clamping to page 1.

## The known limit: two records, one name

Slug identity folds `Wormhole` and `wormhole` into one album, which is what we want. Run the other way, it also folds **two different records that share a name** into one — the `Pilot.`/`Pilot` fold, inverted. No normalizer gets this right, and it is not a normalizer's job.

The answer is the **alias map** `label-entity.md` already records as the eventual fix for both entities (a fold + edit-distance proposes; the operator confirms). Until it exists, the failure mode is a shared page rather than a wrong one, and the page still names every artist and label on it.

## The ops

There is nothing to decide. The album entity has **no admin surface and no operator op** — nothing about a record is an operator decision, and the public pages are SSR loader-driven (the `/artist/<slug>` precedent: a public route is loader + `useLoaderData`, no react-query, no oRPC). What it does have is agent-tier ENRICHMENT sweeps that fill its columns and ask nobody: `backfill_cover_masters` (the owned cover), `describe_album` (the bio), and `backfill_discogs_facts` (the catalogue number + styles above).

The album's (and artist's) **cover art** is its own concern — an owned ≤1200²-capped master in Fluncle's R2, served through Cloudflare Images, best-source-wins. That is [docs/album-artwork.md](./album-artwork.md), not this doc.

The server layer lives in `apps/web/src/lib/server/albums.ts`; the label half in `labels.ts`. The entity-scoped track reads split by shape: the findings grid (`getFindingsBy*`, through the `FINDINGS_FROM` inner join) and the album page's flat quieter tracklist (`listCatalogueTracksByAlbum`, through the anti-join's exact complement) live in `tracks.ts`; the artist- and label-page **grouped** reads (`listArtistCatalogue`, `listLabelCatalogue`) live in `catalogue-groups.ts`, which owns the grouping, the per-group cap, and the pager bound. A crawled track is folded into the artist half of the graph by `linkTracksToArtistEntities` (`artists.ts`) — mint the entity only off a finding, then link every track, the same `album_id`/`label_id` rule — so `/artist/<slug>` reads its catalogue by an indexed `track_artists` seek rather than a full `artists_json` scan.
