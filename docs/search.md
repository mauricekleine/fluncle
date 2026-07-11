# Search — the primary navigation

A feed carries sixty findings. It cannot carry an archive. Search is the surface that takes over as the archive deepens, and the whole design follows from one rule.

## Deterministic first. The model only on a miss. And the model never touches the data.

A query is resolved by trying tiers **in order**, stopping at the first that answers. The order is a performance decision and a safety decision at once.

| #   | Tier              | Example                              | What answers it                                           | Costs                              |
| --- | ----------------- | ------------------------------------ | --------------------------------------------------------- | ---------------------------------- |
| 1   | **Coordinate**    | `004.7.2I`, `fluncle://004.7.2I`     | A regex + one indexed lookup                              | —                                  |
| 2   | **Exact entity**  | `Netsky`, `Hospital Records`         | One indexed lookup on `artists` / `labels` / `albums`     | —                                  |
| 3   | **Bare token**    | `netsky`                             | FTS5 (bm25) + an entity prefix match                      | ~114 ms at 100k (measured, hosted) |
| 3½  | **Sonic phrase**  | `tracks that sound like Nine Clouds` | A regex → the anchor's MuQ vector → `vector_distance_cos` | one vector scan                    |
| 4   | **Anything else** | `Andromedik tracks in A minor`       | A small LLM emits `SearchFilters`; **SQL** retrieves      | one model call, 3s deadline        |

**Tiers 1–3½ are most of what anyone types, and none of them costs a model call.** That is the point of the ordering: the LLM is never on the hot path of a common query.

### An artist, a label, and an album are one affordance

Tier 2 and tier 3 both hand back **entities** — jump targets that sit above the rows. There are three kinds and they are deliberately **one row, one shape, one code path**: the picture, the name, the arrow, and a page to land on (`/artist/<slug>`, `/label/<slug>`, `/album/<slug>` — the graph pages in [docs/album-entity.md](./album-entity.md)). `kind` decides the route and nothing else. Search a label and you are offered the label, with its tracks under it; the same is true of a record, and of a person.

It was not always so. Search shipped before the label and album pages did, so those two came back as a bare `label: …` filter chip — the one thing the reader actually searched for, withheld, because a redirect would have been a 404. That is gone; the chip row now belongs to the model's filters alone (tier 4), which is what it was always for.

Two rails hold:

- **A label or an album is offered only with a certified finding on it.** The [catalogue crawler](./catalogue-crawler.md) mints a `labels` row for every imprint it walks past, and a page with nothing certified on it is a destination that is an empty room. Those decline the jump and fall back to being the filter they always were — never a dead link. (An `albums` row is minted only off a finding by construction, so its guard is a belt-and-braces twin of the label's.)
- **The entity tables are archive-sized, not catalogue-sized** — an album and a label earn a row only off a certified finding — so the prefix match stays a cheap read however deep the catalogue gets.

### The model emits filters, never rows

Tier 4's model is handed a sentence and returns a `SearchFilters` object — `{ artist?, label?, album?, key?, bpmMin?, bpmMax?, yearMin?, yearMax?, text?, soundsLike? }` — which the server compiles into bound SQL over real columns. It never sees a track, never names one, and never returns one. **A hallucinated finding is not a risk that is mitigated here; it is a thing the architecture cannot express.** The worst a bad parse can do is filter for something that is not in the archive and return an honest empty state.

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
