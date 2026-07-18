# RFC: Frontier Editions — weekly-edition history + guaranteed novelty for Fluncle's Frontier

**Status:** Final — decisions locked (4 research threads → /taste → 4-role adversarial panel → operator decisions, 2026-07-18). Completeness standard applied.
**For:** a team of build agents (orchestrated), one PR per unit.
**Canon/authority:** the codebase + `AGENTS.md`, `DESIGN.md`, `VOICE.md`, `docs/local-database.md`, `docs/naming-conventions.md` arbitrate. This is planning, not spec — prune it when the work ships (AGENTS.md).

> Process note: four divergent research threads (data/engine/scale · contracts/route/cron · UI · copy/voice/ISO-week), a /taste pass, a 4-role adversarial panel (staff engineer · DBA/scale · design-voice · product-scope), and a round of operator decisions that locked the open calls. The panel verified the exclusion mechanism is sound and caught two real bugs (folded in); the operator decisions **removed** the relaxation/fallback machinery, the ISO-week code, and the corpus-realism spike, and **added** Unit E (generalize the saved list). Live verifications in the appendix.

## Operator decisions (LOCKED — do not re-litigate)

1. **Design for a big catalogue (thousands of candidates).** By go-live the candidate pool is thousands, not the ~360 today. **`FRONTIER_NOVELTY_WINDOW = 8`, strict exclusion, NO relaxation / fallback / guards.** At thousands of candidates the strict `NOT IN` always fills the target; the panel's "novelty-vs-relevance at small scale" concern is explicitly out of scope.
2. **Label = the edition's date** ("Jul 11, 2026"). No "Week N", so **no ISO-week machinery at all** (no columns, no function, no boundary tests).
3. **The "previous" control is outline/ghost** (the mock's red was a wireframe annotation, never a brand instruction). Settled — not a decision.
4. **Recovery = per-row Spotify link + a per-row Save that works for ANY track** (findings and catalogue alike). This generalizes the saved list from findings-only to any track (Unit E). Not re-seeding.
5. **Do not over-gate sequencing** — there are no users yet; ship the whole feature together behind the existing dark posture rather than staging novelty behind the UI.

## The standard (definition of done)

Boil the ocean: migration, engine change, snapshot hook, the saved-list generalization, contract ops, dropdown + dialog, copy through the gates, tests, and the hosted-scale proof — nothing deferred. Decomposition is **ordering a complete delivery**, not a menu to cut. Tests and docs are acceptance criteria. Dangling threads this build ties off: the `desiredUrisFor`-throws-away-metadata waste (consumed here), the account-deletion path for the new tables, and the findings-only ceiling on the saved list (generalized here).

## 0. Summary / the reframe

- **The unifying primitive: one ledger, read two ways.** A `frontier_editions` snapshot written on each _real_ refresh is both (a) the **novelty ledger** the engine re-derives its exclusion set from and (b) the **history** the dropdown/dialog reads for track-recovery. The write is genuinely coupled (novelty derives from the same rows); the read UI is a separate deliverable sharing the table.
- **The trigger already exists.** `mintOrRefreshFrontierPlaylist`'s `last_uri_hash` mirror guard already computes "did the desired list change?" — the same condition is the edition-creation trigger and the novelty-window unit.
- **Novelty is a refined `NOT IN`, not a new query** (panel-verified sound): the `seedExclusion` idiom extends verbatim with the recent-id set, gated by a new `excludeRecent` flag (true on refresh, false on the live page shelf). Single-pass folded-`min` scan, membership b-tree built once (~8 comparisons/row), no ANN index, no union-all fan-out, ≤264 ids a true hard ceiling, NULL-safe, placeholder budget ≈289 of 32766. **No relaxation** — at big-catalogue scale the strict scan always fills (operator decision #1).
- **Recovery closes the loop, doesn't exit it.** Every edition row carries a Spotify link **and** a Save that files the track into the user's own Fluncle list — which Unit E generalizes from findings-only to any track, so the ~30 catalogue rows in an edition are saveable too.
- **Decomposition:** **A1** (data model + engine novelty + hosted-scale proof) → **A2** (snapshot hook); **E** (generalize the saved list) is independent and can run in parallel with A; **B** (contract ops) needs A + E's store fns; **C** (UI) needs B; **D** (copy) threads through C. Ship it all together (decision #5).

## 1. Context & goals

**Why now.** Fluncle's Frontier full-replaces each user's Spotify playlist weekly, mirroring `listRecommendations`. The engine is deterministic and stateless, and the mirror guard skips the write when nothing changed — so a stable-seed user sees the same ~33 tracks for weeks, and a great track that scrolled past is gone once the list is replaced. This RFC adds the missing state — a per-refresh snapshot — as both guaranteed novelty and a browsable, save-from archive.

**Goals (all in reach):**

1. The weekly Spotify playlist rotates — no track from the last 8 editions returns (designed for a thousands-strong candidate pool, so rotation never starves).
2. A "previous" dropdown → a dialog showing any past edition's frozen tracklist; each row opens in Spotify and can be saved into the user's Fluncle list.
3. Behind the existing dark posture (verified-email gate, `noindex`, `frontier.minting`) with no scale regression on the archive-growing scan.

## 2. Unit A1 — Data model, novelty engine & hosted-scale proof

**Owns:** `apps/web/src/db/schema.ts`, `recommendations.ts`, `account-data.ts`, a scratch-bench script, the migration. Ships first; the hosted-scale proof gates it.

### A1.1 The tables (two, mirroring `mixtapes` + `mixtape_tracks`)

Child rows, **not** a JSON column — the ratified frozen-snapshot precedent (`mixtape_tracks`), and it makes novelty a plain indexed join (no `json_each`-per-row hosted trap).

**Parent `frontier_editions`** — only what a consumer reads (taste: cut speculative columns; a column is one migration away):

| column       | type               | notes                                                                                                                                                                                                      |
| ------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | `text primary key` | `randomUUID()`                                                                                                                                                                                             |
| `user_id`    | `text not null`    | logical FK, no SQL cascade (sibling convention)                                                                                                                                                            |
| `number`     | `integer not null` | per-user monotonic; **one name everywhere** — column, DTO, path param (taste: kills the three-way `edition_number`/`sequence`/`editionId` split; copies the newsletter sibling `get_edition`'s `{number}`) |
| `created_at` | `text not null`    | UTC ISO instant; the date label derives its Amsterdam civil date from this (A1.5)                                                                                                                          |

Indexes: `uniqueIndex(user_id, number)`; `index(user_id, number desc)` (newest-first dropdown **and** the last-8 derive). No `status`/`uri_hash`/`playlist_id`/`iso_*` columns (no reader — date label is locked, so no ISO-week columns).

**Child `frontier_edition_tracks`:**

| column         | type               | notes                                                                                                   |
| -------------- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| `edition_id`   | `text not null`    | → `frontier_editions.id`                                                                                |
| `position`     | `integer not null` | 1-based, **the de-duped PUT order** (A2)                                                                |
| `track_id`     | `text not null`    | the id novelty excludes on; also the id the Save action files (Unit E)                                  |
| `log_id`       | `text`             | set only for certified findings slots (unnamed tier stays unnamed)                                      |
| `title_text`   | `text not null`    | frozen                                                                                                  |
| `artists_text` | `text not null`    | frozen (match `mixtape_tracks.artists_text`)                                                            |
| `cover_url`    | `text`             | frozen                                                                                                  |
| `spotify_uri`  | `text`             | frozen                                                                                                  |
| `spotify_url`  | `text`             | frozen                                                                                                  |
| `bpm`          | `integer`          | frozen instrument readout — the dialog renders the chips, so freeze them (already on the `recs` object) |
| `key`          | `text`             | frozen readout                                                                                          |
| `duration_ms`  | `integer`          | frozen readout                                                                                          |
| `slot`         | `text`             | `"finding"｜"catalogue"` — drives the UI register split (C renders it off this + `log_id`)              |

Indexes: `uniqueIndex(edition_id, position)`; `index(edition_id)`.

**Account deletion (close the dangling thread):** add to `accountDeletionStatements` (`account-data.ts` ~L1108), **child before parent**, inheriting the existing `db.batch(...)` call's mode:

```sql
delete from frontier_edition_tracks where edition_id in (select id from frontier_editions where user_id = ?);
delete from frontier_editions where user_id = ?;
```

Generate via `bun run --cwd apps/web db:generate` (never hand-write SQL); commit the `drizzle/NNNN_*.sql` + `meta/*_snapshot.json` with the schema change.

### A1.2 The engine change — `excludeRecent` + the exclusion SQL

`listRecommendations(user)` gains `options?: { excludeRecent?: boolean }`, default `false` — verified backward-compatible: every non-test caller passes only `user` (`recommendations.tsx:49,80`, `frontier-playlist.ts:160`, `me-recs.ts:106`); a test proves the default path is byte-identical.

**Derive the recent set** (self-healing, from the table — panel confirmed re-derive over materialize is right; **note the outer `user_id` predicate**, DBA P2):

```sql
select fet.track_id
from frontier_editions fe
join frontier_edition_tracks fet on fet.edition_id = fe.id
where fe.user_id = ?                                                     -- binds index(user_id, number desc); bounds the scan to one user
  and fe.id in (select id from frontier_editions where user_id = ? order by number desc limit 8)
group by fet.track_id
```

Read into `excludedIds: string[]`. (No `last_used` tag — the relaxation that needed it is cut.)

**Extend both scans** — verified bind alignment (catalogue `${seedExclusion}` at `recommendations.ts:430`, args `[...probes, ...seedIds, POOL]`; findings :451/:444). Insert `${recentExclusion}` immediately after `${seedExclusion}`, `...excludedIds` immediately after `...seedIds`:

```js
const recentExclusion =
  excludeRecent && excludedIds.length > 0
    ? `and t.track_id not in (${excludedIds.map(() => "?").join(", ")})`
    : "";
// catalogue: args: [...probes, ...seedIds, ...excludedIds, RECOMMENDATIONS_POOL]
// findings:  args: [...probes, ...seedIds, ...excludedIds, FINDINGS_SLOT_COUNT]
```

`track_id` is the `tracks` PK; the `not in` is a membership prune the single-pass fold already visits — no second scan, no per-probe fan-out (panel-verified against the folded-`min` shape). Name the window `export const FRONTIER_NOVELTY_WINDOW = 8;` beside `FRONTIER_DAILY_MINT_CAP`.

**No relaxation / fallback** (operator decision #1). Design assumption, stated in a code comment: the candidate pool is thousands, so `candidates − ≤264 excluded ≫ target` and the strict scan always fills. If the pool were ever small enough to starve, the honest behavior is a shorter playlist that week — not a guard. We do not build for the small-pool case.

### A1.3 Hosted-scale proof (ship gate — the `docs/local-database.md` ritual, corrected per the DBA panel)

No scratch-bench harness exists under `apps/web/scripts`; author a throwaway one. **Local `turso dev` is not evidence.** Scratch hosted Turso, through `@libsql/client/web`, destroyed after.

- **Control the CANDIDATE count, not the `tracks` row count** (DBA P1) — the WHERE (`f.track_id is null and embedding_blob is not null and spotify_uri is not null …`) decides candidates. Sweep candidate counts **5k / 10k (the engine's own tripwire edge) / 25k** — the big-catalogue regime we're designing for — and report **absolute p50**.
- **Absolute budget, not a ratio** (DBA P1): ship gate = the full refresh's p50 **< 800 ms hosted**. A relative bar is worthless if the baseline itself is over budget past the ~5–10k-candidate tripwire.
- **Seed MANY users' editions** (DBA P2, e.g. 10k users × 8) and assert `EXPLAIN QUERY PLAN` on the derive shows a `user_id`-index path, **not** `SCAN frontier_editions` — a one-user seed hides a cross-user scan.
- **Measure the full refresh** — the derive + the catalogue scan-with-exclusion + the findings scan-with-exclusion (one pass each; no relaxation second pass to account for) — report the aggregate per-refresh p50, and confirm the 264-id `not in` did not become a correlated re-scan (`EXPLAIN`: still one pass over `tracks`).
- **Reconcile with the planned per-user cache** (DBA P1): the engine's tripwire comment plans a cache keyed by `(seed set, corpus fingerprint)` past ~5–10k candidates. The novelty set rotates per-refresh and is per-user — **not** in that key. Record the composition the cache work must honor: the refresh path's cache key must include the edition-window hash, or novelty serves stale results / busts the cache every refresh. A1 scopes itself to the pre-cache regime and names this as the explicit follow-on.

### A1.4 The date label — Amsterdam-coherent

`formatDateLong` renders UTC; a near-midnight edition would show a day off from its civil date, so the label derives from the edition's **Amsterdam civil date**: `formatDateLong` applied to `zonedParts(new Date(created_at).getTime(), "Europe/Amsterdam")` (the repo's existing helper, no new dependency). That's the whole of it — no ISO-week code (decision #2).

### A1.5 Migration / backfill — degrades clean

Existing minted rows have zero editions; first post-ship refresh with `excludeRecent=true` derives 0 ids → `recentExclusion=""` → scan behaves exactly as today; the window fills forward. Edition 1 = the first _changed_ refresh after ship. (Honest one-liner: once novelty is on, nearly every week changes, so `unchanged` weeks almost vanish and editions ≈ weeks — this is fine, and cover re-render is _not_ a cost because the refresh path never touches `cover_uploaded_at`.)

## 3. Unit A2 — The snapshot hook

**Owns:** `frontier-playlist.ts`. Needs A1's tables + `excludeRecent`. Ships after A1's proof passes.

**Where:** write the edition on the **two real-write branches only** — never the `unchanged` early-return (`:244`), never `switch_off`. Hash-changed ⇔ edition-written ⇒ exactly-once-per-change by construction.

**`edition number = coalesce(max(number),0)+1` in BOTH branches** (staff HIGH-1 — the draft's literal `= 1` in create-once is a permanent-failure bug: any re-mint with surviving editions collides on `1` forever, silently counted `failed`). On a genuine first mint `max` is null → `1`, so the happy path is unchanged. Add a distinct `logEvent` reason for a `UNIQUE(user_id, number)` collision so it isn't indistinguishable from a Spotify fault (staff LOW-3).

**Convert both write branches to `db.batch([...], "write")`** (staff MED-1 — they use single `.execute()` today: create-once insert `:289-296`, refresh update `:332-337`). Each batch = the existing playlist write **plus** the edition parent + child inserts, sequenced **after** the Spotify PUT returns. `db.batch(_, "write")` is a real `BEGIN…COMMIT` that rolls back on any failure (verified via `setMixtapeMembers`, `mixtapes.ts:224`), so the edition and the `last_uri_hash` update are one atomic unit — a crash between a _split_ write would double-write next week. Do **not** append a separate `.execute`.

**Freeze from the de-duped, ordered URI list the PUT actually sends** (staff MED-2 — `desiredUrisFor` dedupes by `spotify_uri` at `:174-177`; freezing the raw `recs` arrays would record tracks that never reached Spotify). Map each surviving URI back to its rec row (which carries `title/artists/imageUrl/spotifyUri/spotifyUrl/logId?/slot` **and `bpm/key/durationMs`**) and freeze in that order, so the history is a byte-faithful record of the playlist. **Accepted small leak, documented:** novelty keys on `track_id` while the playlist dedupes on `spotify_uri`, so distinct `track_id`s sharing one Spotify track can slip the filter — rare, harmless.

Refactor `desiredUrisFor` to compute `recs = await listRecommendations(user, { excludeRecent: true })` once and both derive the de-duped URIs and hand the surviving rec rows to the snapshot writer (consuming metadata discarded today). It already handles the `Response` (unverified) branch. `mintOrRefreshFrontierPlaylist` returns the created `number`.

## 4. Unit E — Generalize the saved list to any track

**Owns:** `apps/web/src/db/schema.ts` (one nullable change), `account-data.ts`, `apps/web/src/lib/server/orpc/me-saved.ts`, the account saved-list UI. Independent of A/A2 — can run in parallel. Prerequisite for Unit C's Save action on catalogue rows.

**The constraint it removes:** `saveFinding` (`account-data.ts:538`) hard-requires a Log ID — `if (!track?.log_id) return jsonError(404, …, "No finding at that coordinate")` (`:559`) — so today only certified findings can be saved. An edition is mostly catalogue rows (no Log ID), which decision #4 requires be saveable.

**The change (minimal-churn path):**

- **Schema:** make `user_saved_findings.log_id` **nullable** (migration via `db:generate`). Keep the table + route + DTO names as-is — a `finding→track` rename is deferred naming-debt (no users, no data to migrate), and keeping the names means zero `orpc-naming`/coverage/account-page churn. Note the debt in the RFC; a later pass can rename `user_saved_findings` → `user_saved_tracks`.
- **Server:** generalize `saveFinding` to accept any track — resolve the track by id, store `log_id` when the track _is_ a finding, `null` otherwise, and **drop the `!log_id` 404**. Keep the `on conflict(user_id, track_id)` upsert. `listSavedFindings` already selects `log_id` and joins `tracks`, so it returns non-finding rows fine once they exist.
- **Consequence — the account saved-list must render the register split** (design-panel Unlit Rule): saved catalogue tracks now appear on the account saved page, so that list renders a `finding` row with its `RecSeal` and a `catalogue` row **unlit and unnamed** — the same `slot`/`log_id`-driven split Unit C uses. This is the one real fan-out of generalizing, and it's part of E's done.

**Copy (through the gates):** the account list's own header/empty-state may need a word tweak if "Saved findings" now holds non-findings — hand it to `copywriting-fluncle` + `canon-reviewer` as part of E (a track you saved that isn't a certified finding is still "saved", just unnamed).

## 5. Unit B — Contract ops, router, coverage

**Owns:** `packages/contracts/src/orpc/me-frontier.ts`, `index.ts`, `apps/web/src/lib/server/orpc/me-frontier.ts`, coverage tests. Needs A1/A2 store fns `getFrontierEditions(userId)` / `getFrontierEdition(userId, number)`.

**⚠ Naming collision (resolved):** the **newsletter** archive already owns `list_editions`/`get_edition` in a flat `verb_noun`-keyed registry. Follow the `/me` `private`-infix precedent:

- `list_private_frontier_editions` → `GET /me/frontier-editions` (op `listPrivateFrontierEditions`)
- `get_private_frontier_edition` → `GET /me/frontier-editions/{number}` (op `getPrivateFrontierEdition`)

`list`/`get` are already in `APPROVED_VERBS`; both pass `VERB_NOUN_SHAPE`. **Fresh schemas** (do not reuse the newsletter `EditionDTOSchema`): `FrontierEditionSummarySchema { number, refreshedAt, trackCount }`; `FrontierEditionTrackSchema { trackId, title, artists[], imageUrl?, spotifyUrl?, logId?, slot, bpm?, key?, durationMs? }`. Outputs: list → `{ ok, editions: Summary[] }` (zero = empty array, never 404); get → input `{ number: z.string() }` (raw path, parsed in handler), output `{ ok, edition: Summary, tracks: Track[] }`, 404 on missing.

**Auth `privateUserAuth`** (same tier as `get_private_frontier_playlist`); no CSRF (reads), no verified-email gate. Handlers mirror `getFrontier`/`listSeeds`: `.use(privateUserAuth)`, scope every store call by `context.user.id`, `apiFault` try/catch, `ORPCError("NOT_FOUND")` for a missing number.

**Coverage — MANDATORY:** add `list_private_frontier_editions: "private-session"` and `get_private_frontier_edition: "private-session"` to `EXPECTED_TIERS` in `orpc-auth-coverage.test.ts` (forgetting `.use(privateUserAuth)` fails the build). Add the two `PUBLIC_ROUTE_OPS` doc entries in `orpc-coverage.test.ts` (convention). No file route / carve-out — a JSON per-user read is standard oRPC. Reads never consult `frontier.minting` and are inert-but-correct with the switch closed.

## 6. Unit C — UI (dropdown + dialog)

**Owns:** `recommendations.tsx` (header), two new components under `apps/web/src/components/recommendations/`. Every string is a **placeholder** for D. All `@fluncle/ui` components exist — no `shadcn add`.

**Dropdown:** in `recommendations.tsx`'s `<header className="home-masthead">`, a top-right sibling `<div className="home-masthead-actions">` **only in the verified branch** (the `mix.tsx:224` pattern; classes already in `styles.css`). Component = `DropdownMenu`: `DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}` + Phosphor `CaretDownIcon`, `DropdownMenuContent align="end"`, one `DropdownMenuItem` per edition. Returns `null` when `editions.length === 0`.

**Colour:** `variant="ghost"` (an infrequent archive-browse — Quiet Surface, DESIGN.md:293), heating toward Gold Veil on hover (Ignition Rule). **Do NOT copy `mix.tsx`'s terminal masthead control** — that one is a gold `default`; we go quiet here because gold is already spent in the door body on "Get playlist," and the `/recommendations` masthead itself carries no gold (verified). (The mock's red was an annotation — decision #3.)

**Data flow:** **seed the editions summary** into `getRecsGate`'s verified branch (a third `Promise.all` member) + `RecsGate.verified`; `useQuery({ queryKey:["rec-editions"], initialData, queryFn: loadEditions, refetchOnWindowFocus:false, staleTime: 5*60_000 })` (**`staleTime` is load-bearing** — without it the SSR seed is defeated). Invalidate `["rec-editions"]` after a successful mint whose `status ∈ {minted, refreshed}` (plain invalidation; no `editionSequence` field on the mint response). **Per-edition tracklist lazy-loads on open** via `get_private_frontier_edition` (`useQuery`, `enabled: open`, `staleTime: Infinity` — a frozen edition never changes). **No non-null `!`** — render `EditionDialog` returning `null` when the number is null so it narrows inside.

**Dialog:** mirror `subscribe-dialog.tsx`; control via parent state (`open`, `onOpenChange`), not `DialogTrigger`. `DialogContent` already ships portal/overlay/ring/animation/close — don't re-wrap. Header: the **date carries the identity** — quiet "Fluncle's Frontier" to a context eyebrow and lead with the edition's date, so a frozen edition never reads as the _live_ playlist (design-panel Q1). `DialogDescription` = the refreshed date.

**Frozen row — render the register split off `slot`+`log_id`, mirroring `RecommendedPanel`, NOT the uniform `PickRow`** (design-panel V2, blocking — the schema persists `slot`+`log_id` precisely so the split renders; `PickRow` would flatten findings and catalogue into one list, violating the Unlit Rule, DESIGN.md:157). The correct exemplar is `RecommendedPanel`'s `FindingRow`/`CatalogueRow` (`rec-rows.tsx`): a `finding` wears the `RecSeal` (gold coordinate pill → `/log/<id>`, from `log_id`) and catches Gold Veil; a `catalogue` row stays **unlit and unnamed, no Log ID**. Reuse `RecCover` + `padIndex` + `<ol>`; render the readout chips (frozen `bpm`/`key`/`durationMs`). **Two per-row actions** (decision #4): the Spotify open control — `<Button nativeButton={false} render={<a href={spotifyUrl} target="_blank" rel="noopener noreferrer" />} size="icon" variant="ghost" aria-label={…}>` with `SpotifyIcon` from `@/components/platform-icons` (never a Phosphor logo glyph) — and a **Save** control that files the row's `trackId` via the generalized save (Unit E), reusing the door's existing save mutation grammar + its 401/CSRF handling. Save works for both `finding` and `catalogue` rows.

**Accessibility:** base-ui `Dialog` traps/restores focus + Esc-closes; `DropdownMenu` gives arrow-nav/type-ahead/roving focus. Both per-row controls are real focusable `<Button>`s with explicit `aria-label`s. **Verify reduced-motion** (base-ui `animate-in`/`zoom-in-95` grounded under `prefers-reduced-motion: reduce`; add an override if not) in a real driven browser past hydration.

**Two files, one owner:** `frontier-editions.tsx` (the `DropdownMenu` + the single `openNumber` state) renders `edition-dialog.tsx` (the lazy `useQuery` + frozen rows + the two actions). Keep it **out** of `RecommendationsDoor`.

## 7. Unit D — Copy (cross-cutting gate)

**Both gates mandatory** (AGENTS.md Public Copy): write through `copywriting-fluncle`, accept via a `canon-reviewer` pass over the diff (Flat Copy Test blocking). The C brief names both; the **merging orchestrator runs `canon-reviewer` itself**.

**Label = the date** (decision #2). "edition" is on-canon (the newsletter established it; note the mild user-side double-meaning with newsletter editions — acceptable, "edition" is generic for "a version issued at a point in time"). Coordinate/Log ID vocabulary is ruled out, and the same logic bans the certification verb "Dug" on the subtitle.

Pre-drafted canon-clean starting points (each still gets the final `canon-reviewer` pass; reuse ratified twins verbatim — "Open in Spotify", "Digging…", "Try again in a moment." exist):

| Element                 | Draft string                                                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dropdown trigger        | `Past editions`                                                                                                                                                                                                                                 |
| Dropdown item           | `Jul 11, 2026` (the edition's Amsterdam date, `formatDateLong`, newest first)                                                                                                                                                                   |
| Dialog title / identity | date-led; `Fluncle's Frontier` quieted to a context eyebrow                                                                                                                                                                                     |
| Dialog subtitle         | `Refreshed Jul 11, 2026` — **reuse the live panel's ratified freshness string verbatim** (`playlist-panel.tsx:216`); NOT "Dug" (design-panel V1 — "Dug"/"found" is the certification verb; the engine assembled this mirror, it did not dig it) |
| Spotify row a11y label  | `Open ${artist} — ${title} in Spotify`                                                                                                                                                                                                          |
| Save row a11y label     | reuse the door/account save-affordance grammar (`Save ${artist} — ${title}` register)                                                                                                                                                           |
| Empty state             | `No past editions yet. Your first one lands with next week's refresh.`                                                                                                                                                                          |
| Loading                 | `Digging…`                                                                                                                                                                                                                                      |
| Error                   | `Couldn't pull that edition. Try again in a moment.`                                                                                                                                                                                            |

Omit any "recover a forgotten track" rationale line (the live panel's law: "the interface carries the meaning; no helper prose").

## Sequencing & ownership

- **A1** (model + engine + hosted-scale proof gate) → **A2** (snapshot hook). **E** (generalize the saved list) runs in parallel with A. **B** (contract ops) needs A + E; **C** (UI) needs B + E; **D** threads through C.
- **Ship it all together** behind the existing dark posture (decision #5 — no users, so no need to stage novelty behind the UI). One squash-merge per unit; space merges (Cloudflare coalescing) and watch each build green; the migrations ship in their units' deploys.
- **The one thing that de-risks the most:** A1's hosted-scale proof — the only place a latent production cliff could hide, and it's a named ship gate.

## Decisions — all locked

The five open calls are resolved (see "Operator decisions" up top): big-catalogue design / window 8 / no relaxation; date label / no ISO-week; ghost control; recovery = Spotify link + save-any-track (Unit E); ship together. **One residual, low-risk, explicitly deferred:** renaming `user_saved_findings` → `user_saved_tracks` and its routes — kept as-is to avoid churn (Unit E notes the debt). No decision blocks handoff.

## Acceptance criteria

- Migrations via `db:generate` (frontier tables; the nullable `log_id`); `typecheck` + `check` + `apps/web build` + `deploy:gate` green.
- `listRecommendations(user, {excludeRecent:true})` excludes the last-8-editions set; default path proven byte-identical.
- **Hosted-scale proof recorded (ship gate)** — full-refresh p50 **< 800 ms** hosted across the 5k/10k/25k candidate sweep; derive `EXPLAIN` shows a `user_id`-index path under a multi-user seed; cache-key composition documented.
- Snapshot test: a `minted`/`refreshed` sync writes exactly one edition + frozen rows (incl. the readout fields) in one batch; `unchanged` writes none; `number` is `max+1` in both branches; a collision logs a distinct reason. Frozen tracklist byte-matches the de-duped PUT order.
- **Unit E:** a catalogue (no-Log-ID) track saves and lists successfully; the account saved-list renders the finding/catalogue register split; `saveFinding`'s generalization keeps the finding path unchanged (a finding still stores its `log_id`).
- oRPC coverage/auth/naming green with the two new ops; `EXPECTED_TIERS` entries present.
- Account deletion removes a user's editions + edition tracks (tested).
- UI: dropdown renders only for verified + ≥1 edition; dialog opens the selected edition, lazy-loads its tracklist, renders the register split + readout chips, each row opens Spotify and saves; keyboard + focus-trap + reduced-motion verified in a real driven browser.
- Copy authored via `copywriting-fluncle`; `canon-reviewer` pass over the final diff clean (orchestrator-run).

## Risks & open questions

- **Scale of the scan (primary):** the 264-id `NOT IN` shape is sound (panel-verified); the real cliff is the _base scan_ past the ~5–10k-candidate tripwire — covered by the hosted-scale proof's absolute budget + full-refresh measurement. The future per-user cache must fold in the edition-window hash (documented follow-on).
- **Spotify write-volume × the shipped 429 backoff (#675):** with novelty on, the mirror-guard `unchanged` skip nearly never fires, so the weekly sweep issues ~2 PUTs/user/week (details + items) instead of mostly a read — and batch endpoints are gone at this API tier, so no coalescing. Fine at crew scale inside the shipped GET/HEAD/PUT `Retry-After` backoff; keep the sweep serial-per-row (it is); revisit if warn-log volume climbs or the crew grows past the second-app-split threshold.
- **Saved-list rename debt (low):** `user_saved_findings` now holds non-findings; the name is a legacy artifact until a later rename. No functional risk.
- **`number` collision:** near-impossible (serial sweep, rate-limited `/me`), backstopped by the unique index + `max+1` in both branches + a distinct log reason.

## Appendix — verifications & sources

Research + panel grounded in the live files (paths cited inline). Panel live-verifications: **bind order** (`recommendations.ts:418/430/444/451`, aliased `t`); **signature safety** (all four non-test callers pass only `user`); **batch atomicity** (`db.batch(_, "write")` = real BEGIN…COMMIT via `mixtapes.ts:224`); **the scale tripwire** (`recommendations.ts:413`, the 5–10k-candidate cliff + planned `(seed set, corpus fingerprint)` cache); **`desiredUrisFor` dedupes by `spotify_uri`** (`:174-177`); **the two real-write branches use `.execute` today** (`:289-296`, `:332-337`); **`saveFinding` requires `log_id`** (`account-data.ts:559`, the constraint Unit E removes); **cover worklist is `cover_uploaded_at IS NULL`**; **placeholder ceiling** 32766 (libSQL); **the newsletter `editions` naming collision**; **all `@fluncle/ui` components + UI anchors present**. Operator decisions of 2026-07-18 removed the relaxation, ISO-week, and corpus-realism-spike material and added Unit E.
