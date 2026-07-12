# RFC: MusicKit as Fluncle's second metadata authority — one ISRC read, fanned out

**Status:** Final (research → taste → 3-role adversarial panel synthesized, 2026-07-12) — completeness standard applied.
**For:** a team of build agents, orchestrated; each unit is a delegable worktree slice.
**Canon/authority:** the codebase, `docs/catalogue-crawler.md`, `docs/label-entity.md`, `docs/the-ear.md`, `docs/track-lifecycle.md`, `docs/local-database.md`, DESIGN.md/VOICE.md/PRODUCT.md. This is planning, not spec — canon wins on conflict.

> Process note: four divergent research threads (Apple API surface; identity & label graph; artwork ownership; enrichment fuel/previews/backfills), a taste pass, and a 3-role adversarial panel (staff engineer; vendor-risk & data integrity; product-scope & canon). The panel's corrections are baked in — including two blocker-class API-shape errors, a schema hole, and a REF-05 precedent the draft had missed. Verifications in the appendix.

## The standard (definition of done)

Every unit here ships complete — implementation + tests + docs — in the dependency order below. Sequencing is not scope-cutting: U2b and U3b are _staged after their prerequisites prove out_, not optional. The sanctioned external gates: the operator's artwork-risk ruling (decision A), the Cloudflare Images zone toggle (decision B), and Apple's actual coverage of underground DnB (outside our control — measured by the pilot, not assumed). Dangling threads this build ties off: the render pipeline's 300²-upscale defect, the fuzzy iTunes preview rung, and `docs/label-entity.md`'s parked alias-map follow-up.

## 0. Summary / the reframe

- **One ISRC read, fanned out — with two honest entry points.** A single Apple catalog response carries everything at once (URL, album facts, artwork, preview), so no workstream ever fires its own bespoke Apple integration. But the panel proved the draft's "one batched form for everything" wrong: **batched `filter[isrc]` returns one primary song per ISRC with bare refs for alternate pressings, so the canonical-album picker can only run in single-ISRC mode.** U0 therefore exposes both: a batched bulk form (URL/preview drain) and a single-ISRC form with the picker (label/artwork provenance). Facts that later units depend on are **persisted by U1** — the "shared read" is real only for stored facts; live paths (preview, context) make their own budgeted calls.
- **Apple confirms and enriches; it never supplies identity.** Bounded to rows that already carry an ISRC; never mints ISRCs via fuzzy search (the #540 exact-or-nothing rail); never rewrites `tracks.label`. Its outputs are candidates and aliases, resolved by the existing trust hierarchies (operator > curated > free-text) **plus two new guardrails: a distributor denylist and MusicBrainz corroboration** before any `recordLabel` becomes an alias candidate.
- **Ownership with the REF-05 line drawn.** Owned album masters in R2 are the rule for resilience — but **only redistribution-safe bytes on the world-served bucket** (Cover Art Archive first, Spotify floor), **size-capped ≤1500²**, and **Apple's 3000² fetched at render time in-memory, never persisted**. The draft's "own Apple bytes" recommendation reversed REF-05 (the shipped ruling that moved third-party copyrighted media _off_ `found.fluncle.com` as "a copyright exposure") — the panel caught it; the final adopts the middle. The bolder option remains on the table as the operator's explicit call (decision A).
- **The dupe gate (#545, shipped) is the cost argument.** The ISRC veto can only fire where both sides carry an ISRC; every catalogue ISRC this work _confirms_ is a metered capture the gate can newly veto — plus an operator `force_capture` escape hatch this RFC adds, because a wrong-but-confirmed ISRC is otherwise self-sealing.
- **Decomposition & tiering:** U0 (oracle) → U1 (facts + catalogue coverage) are the coupled root and the schema keystone. Reach core: U0, U1, U3a (render fix). Graph quality: U2a (aliases). Staged after proof: U2b (merge/301s), U3b (owned-master program). Opportunistic, wired correctly: U4 (preview rung), U5 (editorial fuel). Schema PRs are **serialized** (one merges, the next rebases and re-generates); only schema-free units parallelize.

## 1. Context & goals

The Apple Developer membership (2026-07-11) and #540 (`apple-music.ts`: exact ISRC → track URL, ES256 token mint with a 150-day cache, agent-tier backfill, ships-dark discipline) opened the catalog API. Four verified facts motivate going further:

1. **The crawled catalogue's ISRC coverage is structurally partial** (MB's DnB ISRC index is patchy — the documented reason the old ISRC→MBID walk was retired), and ISRC is now load-bearing three ways: the Log ID hash, mint-time dedupe, and the #545 capture veto.
2. **`recordLabel` on Apple album objects is a real second label authority** — Spotify exposes no label object, only the free-text string that produced the Medschool/Med School split.
3. **The video render samples the stored 300² JPEG into a 1920² composition** (`packages/video/src/pipeline/fetch-track.ts` passes `albumImageUrl` through untouched) — a ~6.4× upscale on Fluncle's proudest surface.
4. **The preview relay's last rung is already Apple — keyless and fuzzy** (`resolveItunesPreviewUrl`, Dice-scored). Exact-by-ISRC is a strict upgrade of an existing rung.

Honest calibration: Apple's editorial-notes coverage of underground DnB is expected low (bonus fuel, never a dependency); **Apple's catalog coverage of the crawled rows is the load-bearing unknown, and the pilot measures it before anything fans out**; rate limits are undocumented — all pacing is empirical, and the failure regime that matters is a 401/403 token suspension, not a 429 (see the cross-cutting breaker).

## 2. U0 — the oracle: two entry points, one client

**Direction.** Extend `apps/web/src/lib/server/apple-music.ts`, reusing the token mint/cache and outcome-union discipline verbatim:

- **`appleCatalogLookupByIsrc(isrc)`** — single ISRC, `GET /v1/catalog/us/songs?filter[isrc]=<ISRC>&include=albums`. **The canonical-album picker runs here and only here** (the full pressing set is reachable: `data[]` + `meta.filters.isrc[<ISRC>][]`, with album attributes joined from the **top-level `included[]` array by id** — the albums are NOT nested under the song; a builder coding to nesting reads `undefined` for every fact). Used by the pilot, U2's recordLabel cross-check, and U3's artwork provenance.
- **`appleCatalogLookupByIsrcs(isrcs[])`** — batched, ≤25 per request (the documented cap). **No picker** — takes Apple's `data[]` primary per ISRC (fine for a URL/preview: any pressing geo-resolves to the recording). Used by U1's bulk drain.

**The rule that keeps them honest:** recordLabel and artwork-source decisions ride the single-ISRC path; the URL/preview drain rides the batched path. Corrected bundle shape (panel-verified):

```ts
type AppleCatalogBundle = {
  songUrl: string;
  songId: string; // storefront-scoped, re-resolvable, never eternal
  songArtwork?: AppleArtwork; // present on the SONG itself — the batched path can read art without albums
  canonicalAlbum?: {
    // single-ISRC path only (the picker's output, joined from included[])
    id: string;
    recordLabel?: string;
    upc?: string;
    editorialNotesStandard?: string; // HTML-bearing; U5 consumes at context build, never stored
    editorialNotesShort?: string;
    artwork?: AppleArtwork;
  };
  preview?: { url: string }; // mzaf_* CDN asset; resolve-on-demand posture
};
type AppleArtwork = {
  urlTemplate: string;
  width: number;
  height: number;
  bgColor?: string;
  textColor1?: string;
  textColor2?: string;
  textColor3?: string;
  textColor4?: string;
};
```

**The picker** (exported pure function): prefer `isCompilation: false` → earliest `releaseDate` → non-single album over single → deterministic id tiebreak. **Fixture tests must include the adversarial shape**: `data[0]` = a distributor compilation, the correct original album deeper in the set — the exact case the picker exists for. Note honestly: alternate pressings in `meta.filters.isrc` are bare refs, so the single-ISRC picker works over `data[]` + `included[]`; where the primary is a compilation and no alternate album object is included, the picker's output is `canonicalAlbum: undefined` (an honest miss — a follow-up fetch of one alternate href is permitted, budgeted, when the recordLabel is actually needed).

**The pilot (go/no-go, re-scoped by the panel).** Not 3 findings — **~50 catalogue ISRCs sampled from crawled rows**, reporting: Apple hit-rate (the number that decides whether U1/U2/U3's Apple rungs are worth their sweeps), multi-pressing distribution, distributor-recordLabel frequency, and picker behavior on real DnB data. Findings would trivially pass and prove nothing.

## 3. U1 — the facts keystone: schema decided here, catalogue coverage delivered here

**This unit makes the schema decisions the other units depend on — they are NOT builder discretion** (the panel's parallel-collision warning; this repo has the scar).

**Schema (one migration, this unit):**

- **Reliability moves to `tracks`** — the capture-side-channel precedent, not the Discogs precedent. Verified hole: `backfill_apple_music_*` live on `findings`, and `readReliability`/`recordAttempt` hard-code the `findings` table — on a catalogue row they return default-eligible and update zero rows silently, so a naive catalogue sweep re-hits every ISRC every tick with no cooldown, forever. Fix: the four columns move to `tracks` (where `apple_music_url` already lives), the reliability I/O routes `apple_music` to `tracks`, and the migration carries existing findings' state across. A catalogue-aware writer replaces the `setAppleMusicUrl` pairing (its `update findings set updated_at` half becomes conditional — a catalogue row has no lastmod to bump).
- **Album-scoped facts land on `albums`**: `apple_album_id`, `upc`, `record_label_raw`, `artwork_url_template` + `artwork_width`/`artwork_height`, palette columns. recordLabel is an album attribute — storing it at album grain fixes "recordLabel differs per pressing" structurally. U2 reads it there; U3 reads the template there.

**The sweep.** Extend the backfill leg with a catalogue-aware worklist (the `list_track_work` precedent: certified first, then catalogue), batched ISRCs via U0's bulk form, drained by the existing `fluncle-backfill` box cron. Facts write-through: URL + preview presence per track; album facts via the single-ISRC picker path, once per album (not per track). Pacing self-adjusts by the cross-cutting breaker (below). **Falsifiable target:** the current ~5k catalogue rows with ISRCs drain in ≤7 days at the batched form; the builder documents the arithmetic.

**Certification rail note (corrected):** `apple_music_url` is written by the dedicated backfill path, not `updateTrack` — the rail test the draft demanded was aimed at a boundary this field never crosses. The rail applies only if any new fact lands on `findings`; none do (tracks/albums only).

**Product posture (settled by canon):** stored for every row, rendered only on certified surfaces — the Unlit Rule; storing a measure and not rendering it _is_ the certification rail's shape. Verified by a coverage-style test asserting no public component reads `apple_music_url` for uncertified rows.

## 4. U2 — the label second authority: aliases (U2a), then merge (U2b)

### U2a — `label_aliases` + candidate writes + resolution wiring

A `label_aliases` table on the `artist_socials` precedent: `label_id`, `alias` (raw), `alias_slug` (indexed), `source` (`operator|apple|musicbrainz|discogs|spotify`), `kind` (`name|hint`), `status` (`candidate|confirmed`), `created_at`. (JSON-column variant rejected on the label entity's own no-denormalization principle.)

**Candidate guardrails (panel-mandated — ISRC identity alone does not clean `recordLabel`):**

1. **A distributor denylist** (seeded: Believe, AEI, Kontor New Media, The Orchard, Absolute, FUGA, Ingrooves, Symphonic, ADA, Horus Music — a named constant, operator-extendable). A denylisted `recordLabel` never becomes a candidate (dropped, or `kind: hint` at most).
2. **Cross-source corroboration:** an Apple `recordLabel` becomes a `candidate` only when it agrees (by slug-fold) with the MusicBrainz label already on the crawled row. A lone Apple disagreement is a `hint`. This is what makes the ISRC anchor do real work — same recording, two independent authorities agreeing — instead of laundering one distributor string into the graph.
3. `tracks.label` is never rewritten (immutable rail); `labels.name` is never auto-changed (operator display authority; the hierarchy operator > MB/Apple > first-seen _proposes_ only).

**Resolution wiring (the correctness trap, with the perf answer):** `ensureLabel` and `reconcileLabels` (the real symbols — the draft's `canonicalLabelName` does not exist; the crawler's known-spelling resolver is a private helper in `crawl.ts` reached via `ensureLabel` at the crawl path) consult `label_aliases` by `alias_slug` before minting — otherwise the immutable `tracks.label` re-mints merged-away slugs on the next deploy backfill (verified: `reconcileLabels` inserts off the raw string, `on conflict(slug) do nothing`, every deploy). Perf: preload confirmed aliases into a `Map<alias_slug, canonical>` once per reconcile (the `findingCountsBySlug` pattern); `ensureLabel` adds one indexed read. Integration test reproduces the re-mint and proves it closed.

**Operator surface:** a review section on `/admin/labels` — **deliberately a page section, NOT a new attention-queue source**: alias candidates are crawl-volume, and the `label-review` source is capped at 25 precisely because an uncapped crawl-volume source drowns the other five (the doctrine, verified). Low-priority background curation by design. **Every operator string routes through the copywriting-fluncle register** — the draft's "Same label?" is an invented string; parallel the ratified label/artist button language ("Seed from it / Not our lane"; "Looks good"). "Already in the archive" is canon and reusable.

### U2b — merge + redirects (staged after U2a proves on real alias data)

The operator merge op (`merge_label`, operator tier, verb_noun): re-point `tracks.label_id` atomically; `seed_state` resolves by `ruled_at` precedence; operator-vs-operator conflict **stops and asks**; the losing row's `mb_label_id`/`discogs_label_id`/`image_key` reconcile (never lose a logo); the losing slug **301s** to the canonical and the sitemap emits only the canonical. Staged, not optional: U2a kills the split going forward; U2b cleans up pre-existing splits once real candidates have flowed for a week.

**Docs:** `docs/label-entity.md` gains the alias section; its parked follow-up is deleted (this builds it).

## 5. U3 — artwork: the defect fix first, the ownership program behind the REF-05 line

### U3a — the render/DTO fix (reach core, small)

**The panel closed the draft's biggest hole: mobile and the video pipeline never touch web's helpers** — `apps/mobile` renders the raw stored URL directly, and `packages/video/fetch-track.ts` maps `albumImageUrl` straight off `/api/tracks`. So the fix is **server-side, in the DTO**: `/api/tracks` (and the finding DTOs) return the best cover URL available — the owned-master transform URL once U3b resolves one, else the Spotify URL upgraded from the stored 300² to the 640² form. Web's `coverUrl(dto, size)` becomes a thin size-picker over what the DTO carries; **web, mobile, and the video pipeline upgrade for free**. The render additionally prefers a ≥1920 source: until U3b lands, that is **Apple's `{w}x{h}` template fetched at render time, in-memory, never persisted** (the same posture as today's render-time Spotify fetch) via the album facts U1 stored.

**Acceptance (per the operator's own law): a before/after rendered-frame comparison, eyeballed** — dimensions ≥1920 alone can be a 300² upscale wearing a big coat.

### U3b — owned masters (staged; the REF-05 line)

Clone the label-image state machine onto `albums` (`image_key`, `image_state`, `image_source`, `image_attempted_at`, `image_failures`) — and onto the artist-image pipeline for `artists/<slug>.<ext>` (decision A's ruled scope extension). **Master sources (per decision A's ruling): Apple's artwork template downscaled to ≤1200² at ingest, first; Cover Art Archive by MB release next; Spotify's 640² as the floor.** Stored at `albums/<slug>.<ext>` in `fluncle-videos`; `?v=<image_updated_at>` bust on replace (transform caches survive zone purges — the video-variants lesson); cache `immutable`.

**The 3000² original is never stored or served** — the derivative cap is the REF-05-conscious line (a hotlinkable full-res Apple-master archive is a materially different exposure than 1200² display art). Apple's full-res stays render-time-only (U3a). The ingest downscale is a one-time server-side resize before the R2 put (builder's call on mechanism, quality-tested); `image_source` stamps `apple|coverart|spotify`.

**Serving:** owned masters via **Cloudflare Images URL transforms** (`/cdn-cgi/image/…` — a separate one-time zone toggle from the video `/cdn-cgi/media` one; decision B), fixed ladder 64/300/640/1200. **The arithmetic the operator flips the toggle on:** transforms bill per _unique_ (source × size) per month above 5,000 free — the ladder is 4 sizes, so cost ≈ (albums _viewed that month_ × 4 − 5,000) × $0.0005; at 1,250 viewed albums/month it is $0; at 5,000 viewed it is ~$7.50/month; catalogue _size_ is irrelevant, only traffic counts. R2 storage: ~free at current scale (~$2/month at 100k albums).

## 6. U4 — previews: the fuzzy rung becomes exact (opportunistic, wired honestly)

Insert exact-Apple-by-ISRC as rung 3 in `preview-live.ts`, demoting fuzzy-iTunes to rung 4 (kept: the keyless fallback when MusicKit is unprovisioned or the row has no ISRC). **Honest coupling statement (panel):** this is a live authed Apple call on a user-facing hot path, sharing the one undocumented budget with the sweeps — the RFC accepts that explicitly, with two mitigations: a short per-request timeout falling through to rung 4, and the global breaker (below) short-circuiting the rung entirely when tripped, so a sweep throttle degrades to today's behavior rather than user-visible latency. Apple `mzaf_*` preview URLs are unsigned CDN paths but stay **resolve-on-demand, never stored as durable** (assets get re-mastered). Analysis policy unchanged: previews never feed vectors, never enter the private analysis archive.

## 7. U5 — editorial notes: facts fuel with a mechanical gate (opportunistic)

`fetchTrackContext` gains an Apple source at context-build time: strip HTML, append to the same `snippets[]` array the Firecrawl results ride, labeled as untrusted source text; Apple's page URL joins `sources[]` (sufficient provenance; no new column). **The echo defense is mechanical, not prompt-trust (panel):** a runtime n-gram gate at the distil boundary — any contiguous ≥7-token span from the Apple source appearing verbatim in the authored note **rejects the note to empty** (fill-empty-only already makes empty the honest floor). The fixture test regresses the _gate_, not the prompt. Fill-empty-only semantics unchanged; coverage honestly expected sparse for underground DnB — wired correctly as bonus fuel, ranked opportunistic.

## Cross-cutting: the Apple failure-regime breaker (new, panel-mandated)

The shipped client backs off only on 429; **a developer-token suspension surfaces as 401/403 — which today clears the cached token and retries harder** (verified). One undocumented budget is shared by every unit, and U0 is a designed single point of failure: one bad token darkens five surfaces at once. So:

1. **K-consecutive 401/403 (K≈3) trips a persistent breaker** — a `settings` flag with a cooldown (the `label-images.ts` circuit-breaker precedent), stopping every Apple-touching sweep and short-circuiting U4's live rung. Operator reset op to clear early.
2. **A shared Apple-call meter** (settings KV, rolling window) every sweep consults — U1's drain cannot invisibly collide with U4/U5's live calls.
3. **The dupe-veto escape hatch:** an operator-tier `force_capture` (or `clear_duplicate`) op sets a sticky override the rank sweep respects — because a wrong-but-confirmed ISRC otherwise vetoes a real track from capture _forever_, and the post-embed similarity check that would exonerate it never runs (the veto is self-sealing). Surfaced beside the "already in the archive" marker on the catalogue board.

## Sequencing & ownership

1. **U0** (oracle, two entry points, picker + adversarial fixtures) → **the 50-catalogue-ISRC pilot** (go/no-go: hit-rate + distributor frequency). Nothing fans out before its numbers land.
2. **U1** (the schema keystone: reliability→tracks migration, album facts, catalogue sweep). **Schema PRs serialize from here on**: one schema PR merges, the next rebases and re-runs `db:generate` (empty-diff verify) — never two schema branches generating concurrently. U4/U5 are schema-free and may parallelize with U1's sweep work once U0 merges.
3. **U3a** (DTO cover fix + render-time Apple fetch) — independent of U2; touches no schema beyond U1's facts.
4. **U2a** (aliases) after U1's recordLabel facts exist; **U2b** (merge/301s) a week of real candidates later.
5. **U3b** (owned masters) after decisions A + B; independent of Apple entirely on the stored path.
6. The breaker + meter land with U1 (they gate its sweep).

**De-risks the most:** the pilot. **Deploy discipline:** each unit a PR; space deploy-triggering merges (build coalescing).

## Decisions needed BEFORE handoff

Settled by canon, not decisions (cited, demoted): fuzzy-ISRC supply rejected (#540's exact-or-nothing rail); catalogue links stored-not-rendered (certification rail + Unlit Rule); `labels.name` authority order (the ratified operator > curated > free-text hierarchy); preview rung order (a strict quality upgrade).

All three RULED by the operator, 2026-07-12:

**A. Artwork risk posture — RULED: the 1200-derivative middle.** Owned masters are **downscaled derivatives capped at 1200²**, stored at `albums/<slug>.<ext>` (and `artists/<slug>.<ext>`) in the existing `fluncle-videos` bucket behind found.fluncle.com (the label-logo precedent; no new bucket). Source ranking for the derivative: **Apple's artwork template (downscaled to ≤1200 at ingest) > Cover Art Archive > Spotify 640**. The 3000² original is NEVER stored or served — the video render fetches it at render time, in-memory, never persisted (stored 1200 for the web, ephemeral 3000 for the films). Honest posture: a downscaled copy is still a copy, but it is the non-substitutional display posture, and the operator's **label-outreach program** (ROADMAP, week of 2026-07-13) is the path that converts it to blessed. **Scope extension (ruled): artist images join U3b** — Apple artist objects carry artwork; it slots into the existing artist-image pipeline as a higher-res source. Labels stay Discogs/Wikidata-only (Apple has no label entity).
**B. The Cloudflare Images zone toggle — CONFIRMED.** Operator flips it before U3b merges (~$0 at current traffic; arithmetic in U3b).
**C. Public alias visibility — CONFIRMED.** `confirmed` label aliases feed the `/label` page's `Organization` JSON-LD as `alternateName`; `candidate`/`hint` stay admin-only.

## Acceptance criteria

- **U0:** picker fixtures include the distributor-compilation-first adversarial case; the two entry points' contracts tested; pilot report delivered with hit-rate + distributor stats over ~50 catalogue ISRCs.
- **U1:** reliability columns on `tracks` with the carry-across migration proven; catalogue rows gain URL/facts at a documented pace (≤7 days for the current backlog, arithmetic shown); a coverage-style test proves no public component renders `apple_music_url` on uncertified rows; breaker + meter tested (429, 401/403, trip, reset).
- **U2a:** alias table + guardrails (denylist, MB corroboration) unit-tested; the re-mint regression test; board section strings passed the copywriting register.
- **U2b:** merge op with `ruled_at` precedence + stop-and-ask tested; 301 + canonical sitemap verified live on a real merged pair.
- **U3a:** **before/after rendered frames compared by eye** (the operator's view-frames law); mobile + video pipeline verified consuming the upgraded DTO URL.
- **U3b:** a replaced master's `?v` bust proven against cached renditions; `image_source` provenance stamped; a test proves every stored master is ≤1200 on its longest side (the decision-A cap) and that no code path writes the un-downscaled original to R2; artist images verified through the same cap.
- **U4:** a finding with a dead Deezer preview plays via the exact rung; the breaker short-circuit falls through to fuzzy-iTunes; timeout fall-through tested.
- **U5:** the n-gram gate rejects a seeded verbatim-echo fixture to empty and passes a clean one; `sources[]` carries the Apple URL.
- Docs updated per unit: `label-entity.md`, `the-ear.md` (ISRC coverage + force_capture), a new `docs/album-artwork.md` (or a `video-variants.md` sibling section), `track-lifecycle.md` touchpoints. All quality gates green per unit.

## Risks & open questions

- **Apple TOS thinness** — no verbatim storage clause found either way; decision A is the operator's, with REF-05 as the in-repo precedent.
- **A token suspension darkens five surfaces at once** (U0 is a designed single point of failure) — the breaker bounds the damage; the keyless fuzzy preview rung and the Spotify cover floor are the degraded modes.
- **Apple catalog coverage of crawled DnB is unknown until the pilot** — if the hit-rate is poor, U1 still pays for itself on findings + the covered fraction, but U2/U3's Apple rungs shrink; the pilot report re-scopes honestly.
- **`isCompilation` reliability** — the picker leans on editorial metadata that is wrong or absent on some independent releases; the distributor denylist + MB corroboration are the backstops.
- **Alias merges are the one user-visible risk** (slug 301s, seed-state precedence) — mitigated by staging (U2b), stop-and-ask, and tests.
- **CAA coverage/resolution variance** — the owned-master sweep may fill slowly; the DTO's Spotify floor and render-time Apple fetch carry quality meanwhile.

## Appendix — verifications & sources

Panel live verifications (2026-07-12): batched `filter[isrc]` response shape (bare refs in `meta.filters.isrc`, attributes only for `data[]` + `included[]`) — Apple docs, confirming B1/B2; `backfill_apple_music_*` on `findings` + `readReliability`/`recordAttempt` hard-coding `findings` (`schema.ts:427-430`, `backfill.ts`) — the M1 hole; `apps/mobile` reading the raw cover URL directly and `fetch-track.ts:60` passing it through — the M3 hole; `apple-music.ts:247-259` 401/403-clears-token-no-backoff; REF-05's ruling in `wrangler.jsonc:53-56` ("moved off the world-served VIDEOS bucket, which was a copyright exposure"); `LABEL_REVIEW_QUEUE_LIMIT = 25` and the drowning rationale (`label-entity.md`); `reconcileLabels` minting off the raw string every deploy (`labels.ts:390`); "Same label?" absent from canon (grep); the-ear.md §Duplicates shipped with no operator override (the force_capture gap). Research sources: Apple Music API docs (songs/albums/artists attributes, artwork, storefronts, developer tokens; Context7 `/websites/developer_apple_applemusicapi`), MusicBrainz alias docs, Cloudflare Images/R2 pricing, Apple artwork specs (3000²), MusicBrainz "How to Identify Labels".
