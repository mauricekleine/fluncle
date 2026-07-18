# RFC: the Frontier shelf reads from the ledger — recommendations off the hot path

**Status:** in-flight plan (not built). **Depends on:** the Frontier Editions machinery (built dark, `docs/rfcs/frontier-editions-rfc.md`) and the Apify anchor sweep (live, `docs/catalogue-crawler.md` § the anchor). **Prune this file when the work ships.**

## The problem, measured

The `/recommendations` shelf is computed live on every page view: the SSR loader runs `listRecommendations` — a 12-probe exact vector scan over the eligible catalogue — before the document renders. That was fine at ~370 eligible rows (240–400 ms, measured 2026-07-18 on hosted prod with bound-blob probes, the exact production shape). It stops being fine on a known clock: the anchor sweep (live, hourly, embedded-first) grows the eligible pool toward every embedded row, and the same measured curve reads **~1.5–2.5 s at 4k candidates and 2.3–4.0 s at 6.6k** — the full embedded set, reachable in ~2–3 weeks at the sweep's default pace. The scan is linear with no cliff (rank-in-SQL, 115 skinny rows on the wire, nothing that can OOM or wedge), so this is a UX and row-read-budget degradation, not an outage risk — but it walks the page back from 1.1 s to multi-second loads, and it burns ~30k Turso row reads per view on the paid plan.

The scale-tripwire comment in `recommendations.ts` (the catalogue scan) already names the move: take the engine off the hot path. This RFC is that move — and the Frontier Editions work already built most of it.

## The insight: the cache the tripwire wants already exists as a product object

Editions (`frontier_editions` + `frontier_edition_tracks`) are per-user, frozen, display-ready snapshots of the engine's output, written transactionally by the exact engine run the weekly refresh already pays for. The RFC'd "per-user cache keyed by seed set + corpus fingerprint" would be a second, invisible copy of the same thing with a worse invalidation story (the corpus fingerprint now moves EVERY HOUR with the anchor sweep — a fingerprint-keyed cache would recompute near-constantly for nothing). The durable shape is instead:

**The shelf IS the latest edition.** Page views read a stored edition (single-row + child-rows read, milliseconds at any pool size). The engine runs only on WRITE triggers — a seed change, the weekly refresh, an explicit refresh — never on a read. Corpus growth does not invalidate anything: freshness rides the weekly cadence, which is what the surface already promises ("refreshed weekly") and what the editions product model already ratified.

## The product model (operator-ratified 2026-07-18)

**Editions = recommendations.** The shelf renders the seeds + the LATEST edition; the dropdown renders the previous ones; Friday writes the next one and (when minting is open) syncs it to Spotify — so Saturday's page shows Friday's edition. The shelf therefore shows the **novelty blend** (`excludeRecent: true`, the last-8-editions window): a shelf that re-digs weekly beats a static leaderboard, and the shelf and the minted playlist are the same object (no "why does my playlist differ from the page" seam). The novelty window needs no first-edition special case — an empty ledger excludes nothing by construction. Before the first commitment there is only the DRAFT (D2): a live view that is "purely the recommendation" until "Get playlist" mints it into edition #1.

## Design

### D1 — Editions decouple from Spotify minting

Today an edition is written only inside `mintOrRefreshFrontierPlaylist` behind the `frontier.minting` kill switch (`switch_off` writes nothing). Split the two effects: `computeAndStoreEdition(user)` (engine → transactional edition write, ALWAYS allowed) and the Spotify mirror (stays behind `frontier.minting` + the daily cap + the `last_uri_hash` guard, unchanged). The kill switch keeps gating the EXTERNAL effect (Spotify writes); it stops gating the INTERNAL cache. `writeFrontierEdition`'s hash-skip survives as "identical desired list → no new edition row".

### D2 — The draft-then-checkpoint model (operator-ratified 2026-07-18)

**Before the first "Get playlist": the DRAFT phase.** A user with seeds but no edition sees a LIVE, ephemeral recommendation view — recomputed as they add/remove seeds, persisted nowhere, no dropdown, no edition rows. Nothing to rank novelty against and nothing written: the empty ledger makes `excludeRecent` a no-op by construction. This keeps the live scan on the read path for exactly one bounded cohort (each user passes through the draft once, rate-limited), which is also the one moment live-per-seed recompute is the DESIRED behavior.

**"Get playlist" is the commitment moment.** It births edition #1 (the engine's output, frozen) and — only when `frontier.minting` is open — the Spotify playlist mirroring it. With minting dark it births just the edition; the mirror waits for the flip (D1).

**After the first edition, the engine runs on exactly three triggers, and a shelf read is never one of them:**

- **The weekly refresh sweep** (`refresh_frontier_playlists`, Fri 07:00 Amsterdam): already runs the engine per user; the edition write now happens regardless of the minting switch, the Spotify mirror stays conditional. Saturday's shelf is Friday's edition.
- **Explicit refresh**: the page's refresh action writes the next edition on demand. The per-user hourly rate limit moves from the read (now ~free) to this recompute path.
- **A seed change does NOT silently rewrite anything.** Seeds are inputs; editions are checkpoints. A post-mint seed write leaves the latest edition (and any synced playlist) untouched and the shelf shows a quiet staleness nudge — the picks changed since this edition; refresh writes the next one. This kills same-day-replace transaction complexity outright and prevents mid-week Spotify playlist churn from seed fiddling.

### D3 — The read path

`getRecsGate` / `getRecommendations` serve the latest edition: parent row + child rows, ordered by `position`, split back into the findings/catalogue registers by the stored `slot`. No vector math on any read. The past-editions dropdown/dialog (Unit C/D) is unchanged — the shelf simply becomes edition N while the dropdown shows N−1…N−8.

### D4 — Schema deltas (one migration, via `db:generate`)

`frontier_edition_tracks` gains `similarity` (real, nullable) — the shelf displays the honest number and the readout chips; frozen rows must carry it. `frontier_editions` gains `seeds_used` (int) + `seeds_skipped_json` (text) so the shelf's honesty strings ("these two picks aren't steering yet") survive the freeze. Old rows: columns nullable, UI degrades to omitting what a pre-migration edition cannot back (the Readout Rule's honest absence).

### D5 — What gets deleted

The live-scan path out of the route: `getRecsGate`'s direct `listRecommendations` call, the react-query `staleTime` load-bearing comment (reads become genuinely cheap), and the read-side rate-limit plumbing. `listRecommendations` itself survives untouched as the engine the write triggers call — including the sonic scans, the register split, and the novelty window.

## What this does NOT change

The engine's SQL (already the ratified single-pass shape), the seed CRUD contracts, the editions read ops (Unit B), the dialog UI, the anchor sweep, the `frontier.minting` switch semantics for Spotify writes, and the CLI. Mobile/MCP surfaces that might later read recommendations read editions for free.

## Units (each PR-able, in order)

- **U1 — decouple + triggers** (D1, D2): `computeAndStoreEdition`, same-day replace, seed-write hooks, lazy first-visit backfill, refresh-sweep rewire. Integration-tested against the real schema (the editions test discipline).
- **U2 — schema + freeze the honesty fields** (D4): migration, writer carries similarity/seeds meta, reader returns them.
- **U3 — the shelf reads the ledger** (D3, D5): route/loader/serverFns/door rewire, rate-limit move, copy check on the "Refreshed <date>" line (`copywriting-fluncle` + canon-reviewer — this touches public strings).
- **U4 — proof + activation**: the existing `bench-frontier-novelty.ts` hosted-scale run (the editions RFC's own gate, now doubly load-bearing since novelty is on the shelf), a hosted timing of the edition read at 10k+ child rows, then the operator flips `frontier.minting` when ready for the Spotify half — the shelf no longer waits for it.

## Sizing and risk

One build-agent slice comparable to the anchor sweep (a day, delegated): ~2 server modules touched, 1 migration, 1 route rewire, tests throughout. Riskiest edge: the same-day-replace transaction (must not strand child rows — same `db.batch` discipline as `writeFrontierEdition`). The page regains its 1.1 s load at ANY pool size, every view stops billing ~30k row reads, and the engine runs exactly as often as the product has reasons to re-dig: seeds, Fridays, and the refresh button.
