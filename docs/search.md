# Search — the primary navigation

A feed carries sixty findings. It cannot carry an archive. Search is the surface that takes over as the archive deepens, and the whole design follows from one rule.

## Deterministic first. The model only on a miss. And the model never touches the data.

A query is resolved by trying tiers **in order**, stopping at the first that answers. The order is a performance decision and a safety decision at once.

| #   | Tier              | Example                              | What answers it                                                                 | Costs                              |
| --- | ----------------- | ------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | **Coordinate**    | `004.7.2I`, `fluncle://004.7.2I`     | A regex + one indexed lookup                                                    | —                                  |
| 2   | **Exact entity**  | `Netsky`, `Hospital Records`         | One indexed lookup on `artists` / `labels` / `albums` / `galaxies` / `mixtapes` | —                                  |
| 3   | **Bare token**    | `netsky`                             | FTS5 (bm25) + an entity prefix match                                            | ~114 ms at 100k (measured, hosted) |
| 3½  | **Sonic phrase**  | `tracks that sound like Nine Clouds` | A regex → the anchor's MuQ vector → `vector_distance_cos`                       | one vector scan                    |
| 4   | **Anything else** | `Andromedik tracks in A minor`       | A small LLM emits `SearchFilters`; **SQL** retrieves                            | one model call, 3s deadline        |

**Tiers 1–3½ are most of what anyone types, and none of them costs a model call.** That is the point of the ordering: the LLM is never on the hot path of a common query.

### Every graph node with a page is one affordance

Tier 2 and tier 3 both hand back **entities** — jump targets that sit above the rows. There are five kinds and they are deliberately **one row, one shape, one code path**: the picture, the name, the arrow, and a page to land on — an artist (`/artist/<slug>`), a label (`/label/<slug>`), an album (`/album/<slug>`), a named galaxy (`/galaxies/<slug>`), and a published mixtape whose page IS its log page (`/log/<F-logId>`). `kind` picks the route for the first three; where it does not (a galaxy's plural segment, a mixtape's log page), the row carries an explicit `url`, so no consumer special-cases the route. Search a label and you are offered the label, with its tracks under it; the same is true of a record, a person, a galaxy, and a mixtape — though a galaxy and a mixtape are a **pure jump** (a mixtape is itself one finding; a galaxy has no column filter to list under it), so they carry no track list.

It was not always so. Search shipped before the label and album pages did, so those two came back as a bare `label: …` filter chip — the one thing the reader actually searched for, withheld, because a redirect would have been a 404. That is gone; the chip row now belongs to the model's filters alone (tier 4), which is what it was always for.

Two rails hold:

- **A label or an album is offered when it clears the shared hub gate.** Search offers exactly the labels/albums the `/labels` + `/albums` hubs and the API list — a certified finding **or** a page that clears the thin-content floor (the same `HUB_INCLUSION_HAVING` fragment from `labels.ts`). This replaced the old certified-only guard when the unified hub index shipped: a catalogue-only label with enough renderable tracks now has a real page, so withholding it would be the lie. A below-floor imprint (the [catalogue crawler](./catalogue-crawler.md) mints a `labels` row for every one it walks past) still declines the jump and falls back to the filter it always was — never a dead link.
- **The entity reads are archive-sized, not catalogue-sized** — a label/album is bounded by that floor, and galaxies and mixtapes are dozens — so the exact/prefix match stays a cheap read however deep the catalogue gets. A galaxy resolves only when it is **named and not retired**; a mixtape only when it is **published**.

### An artist answers to every name

DnB has a many-names problem: a producer records under several names for one identity. The [artist entity](./artist-relationship.md) already solves it in storage — the MusicBrainz-harvested AKAs land in `artist_aliases`, keyed to the canonical `artists.id` — and the artist read here folds that table in, so an alias resolves to the artist exactly as the primary name does. It happens in the **deterministic tiers**, on the same entity code path: exact in tier 2 (type an act's other name, jump to their page with their findings under it), prefix in tier 3 (type the start of an AKA, the artist surfaces as a jump target). No FTS index is touched — an alias is keyed on `artist_id`, not on `tracks`, so the honest place to answer it is the entity read, not a denormalised copy of the AKA onto the track index. And because it sits **in front of the model**, an AKA keeps resolving when the LLM is down — the same rule the whole resolver is built on.

Two rules carry the trust and the tie:

- **Only a trusted display-name alias resolves** — `kind='name'` and `status in ('auto','confirmed')`, the exact set that feeds the public `alternateName`. For an artist there is no weaker `candidate` tier: a MusicBrainz alias is a direct statement of identity (born `auto`, trusted like an operator's `confirmed`), unlike the fuzzy cross-source `candidate` a `label_aliases` row must earn. A `hint` — a weak MB "Search hint" lead, never rendered publicly — never resolves a search either.
- **The primary name wins a tie.** A query that is one artist's real name and another's AKA lands on the one it names directly: the read ranks a name match ahead of an alias-only match before length and alphabetical order.

### The model emits filters, never rows

Tier 4's model is handed a sentence and returns a `SearchFilters` object — `{ artist?, label?, album?, key?, bpmMin?, bpmMax?, yearMin?, yearMax?, text?, soundsLike?, soundsLikeArtists? }` — which the server compiles into bound SQL over real columns. It never sees a track, never names one, and never returns one. **A hallucinated finding is not a risk that is mitigated here; it is a thing the architecture cannot express.** The worst a bad parse can do is filter for something that is not in the archive and return an honest empty state.

The schema is the safety property. A model that tries to hand back tracks hands back nothing (`parseFilterReply` validates against the Zod schema, and the schema has no field that could carry a result).

### It degrades; it never breaks

`translateQuery` returns `null` when the model is unprovisioned, slow (past a 3-second deadline), or failing — every failure mode collapses to that one answer. Tier 4 then falls back to FTS5 with **OR** semantics: bm25 ranks by rarity, so the one distinctive word in the sentence carries the result. The response carries `degraded: true` and the dialog says so, rather than passing text hits off as the filters you asked for.

Asked _"Andromedik tracks in A minor"_ with no model, it still surfaces the Andromedik tracks.

**In local dev this is the steady state** — `OPENROUTER_API_KEY` is a production Worker secret and the local template does not carry it — so the degradation path is exercised every day, by everyone, for free.

### Sonic search is deliberately NOT the model's job

`soundsLike` can come from the model, but the ordinary phrasings (`sounds like X`, `similar to X`, `like X`) are matched by a **regex** in tier 3½. Two reasons, and both matter:

- Sonic search is the one thing no other drum & bass tool has, so it will be one of the most-typed shapes here. A model in front of it breaks the rule the resolver is built on.
- It must not go down when a vendor does.

The model still owns what the regex cannot see: an unusual phrasing, and — the real prize — a **compound** query (`like Nine Clouds but on Hospital Records`), where the reference is only half the question and the other half becomes the btree pre-filter in front of the vector scan.

The reference is always resolved to a **real, embedded row** in the archive. If it resolves to nothing, the tier declines. **The vibe is always anchored on a track that exists.**

### Sound like several artists — the compound artist query

`soundsLikeArtists` (1–6 artist names or slugs) is the other sonic hook: _"songs by artists that sound like Koven and Maduk in A minor from before 2020"_. The server resolves each name to an artist (the alias-tolerant read the entity tier uses), reads their stored `artist_centroids`, averages them into **one probe** (the mean of means, so each named artist weighs equally regardless of catalogue depth), and ranks **tracks** by `vector_distance_cos` against it — the same one-pass exact scan, with every other filter (key/BPM/year/label) applied as the btree pre-filter first. A name that resolves to no artist (or one with no centroid yet) simply does not weigh in; a probe of nothing declines. The response echoes the **resolved** artist names back in `filters.soundsLikeArtists`, so the reader sees which artists the vibe was actually built from.

It is a plain filter like any other: the LLM only ever _emits_ it, and a hand-built `soundsLikeArtists` filter works with the model down.

## The vector rules (non-negotiable)

All three are from [docs/local-database.md](./local-database.md), all three are measured, and all three are invisible in local dev:

1. **Rank in SQL** (`vector_distance_cos … order by … limit N`). Never pull embeddings into the isolate — that is how a query silently grows toward OOMing the 128 MB Worker.
2. **Bind the probe as a raw BLOB** (`toVectorProbe`), never as a JSON string: 1,883 ms vs 26,700 ms at 100k on hosted. Locally, identical either way.
3. **Never `CREATE INDEX … libsql_vector_idx`.** It wedged hosted Turso's write path for 20+ minutes and silently builds an EMPTY index locally. The ratified shape is an exact scan with a btree pre-filter.

## The catalogue rule

`tracks` is the universal music object; `findings` is the certification, 1:1 and present only for a track Fluncle certified ([docs/track-lifecycle.md](./track-lifecycle.md)). Search is the **one** public surface that reads through a `LEFT JOIN` rather than the `FINDINGS_FROM` inner join every finding surface drives through — because the depth behind the findings is the whole product.

A track with no `findings` row comes back with `certified: false`, **no coordinate**, and a Spotify URL. It renders in DESIGN.md's **Unlit Rule** register: no gold, no coordinate, the Dust Veil on hover, and a link OUT (there is no `/log` page for a track Fluncle has not been to).

**It is never named.** No heading over those rows, no badge on them, no noun anywhere. The tier is not a concept the reader is asked to learn. _"Finding" stays the only named object in Fluncle's world._

The one place certified-first is **not** applied is the sonic ranking, and that is arithmetic rather than taste: `bm25` is corpus-relative (scores across a 60-row and a 41k-row corpus are not on one scale, so a blended text ranking would be meaningless), while a cosine distance is a property of two vectors and nothing else. Sound can be ranked honestly across both tiers; text cannot.

## The FTS5 index is not a migration

`tracks_fts` is a standalone FTS5 virtual table kept in step with `tracks` by three triggers — **the app never writes to it.** Its DDL lives in `apps/web/src/db/search-index.ts`, not in `apps/web/drizzle/`, because Drizzle's schema DSL cannot model a virtual table or a trigger and this repo does not hand-write migrations.

It does not need one. **An FTS index is a derived artifact, not schema history**: every byte is reconstructible from `tracks` in one SELECT. So it is built the way derived artifacts are built here — an idempotent, self-healing `ensureSearchIndex` folded into `db:migrate`, which reaches exactly the places a migration would: the Cloudflare deploy, every local dev boot, and the in-memory integration harness. It also sidesteps libsql#1811 (the open FTS5-inside-`db.batch()` panic) for free, since `drizzle-kit migrate` applies a migration file through `batch()` and these statements run one at a time.

Two traps live in that file's header: FTS5's `MATCH` is a **query language** (a bind slot does not neutralise its operators — the expression is rebuilt from scrubbed tokens, never interpolated), and `INSERT OR REPLACE INTO tracks` would not fire the delete trigger. Every write path is a plain `INSERT`/`UPDATE`; the count reconcile is the backstop.

## The surface

- **API:** `search_archive` → `GET /api/v1/search/archive?q=…` (public, unauthenticated, rate-limited). Registered in `@fluncle/registry` as `api.search.archive`. Distinct from `search_tracks` (`GET /search`), which searches **Spotify** for submission candidates.
- **UI:** a quiet trigger at the far end of the colophon top bar, and **⌘K / Ctrl+K from every public page**. The text input lives inside the Shadcn `Command` dialog; the bar is only a way in. An empty input shows four example queries as pills — one per tier — chosen because they actually return rows.
- **Files:** `apps/web/src/lib/search-query.ts` (the pure core: the coordinate regex, the sonic regex, the FTS expression builder, the key spellings), `apps/web/src/lib/server/search.ts` (the resolver), `apps/web/src/lib/server/search-llm.ts` (tier 4), `apps/web/src/components/search/search-command.tsx` (the dialog).

## Operating it

Tier 4 needs `OPENROUTER_API_KEY` — **already a production Worker secret** (the context-note distil uses it), so tier 4 is live on deploy with no new secret to set. `OPENROUTER_SEARCH_MODEL` optionally overrides the model (default `anthropic/claude-haiku-4.5`); it is kept separate from `OPENROUTER_CONTEXT_MODEL` because one is a summariser and the other a parser. Its spend lands in the COST-01 ledger under the `search` step.

## The filter prompt is operator-tunable

The LLM tier's system prompt is the `search_filter` entry in the **prompt registry** ([docs/agents/prompt-registry.md](./agents/prompt-registry.md)), so it can be retuned from `/admin/prompts` with no deploy. It is the SAFEST of the seven to make editable, for the same reason the tier is safe at all: its output is Zod-validated and the model is never on the hot path, so a bad edit degrades search to the full-text tier rather than corrupting a result. The resolve falls back to the repo's baked default whenever the prompt store cannot be read, which leaves the degradation contract exactly as it was.
