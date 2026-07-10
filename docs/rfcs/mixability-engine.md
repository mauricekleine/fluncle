# RFC: The Mixability Engine — one shared scoring core, two products (the /mix set-builder + the dream-weaver)

**Status:** Draft (divergent research, a taste pass, and a 4-role adversarial panel — staff engineer, design/brand, music-informatics, product/scope — synthesized 2026-07-10; the panel's live verifications and corrections are baked in).
**For:** a fresh build session or a team of worktree agents.
**Canon/authority:** the codebase, DESIGN.md, VOICE.md (→ `packages/skills/copywriting-fluncle/references/voice.md`), PRODUCT.md, docs/naming-conventions.md, docs/admin-shell.md. This is planning, not spec — prune once built.

## The standard (definition of done)

Nothing here is deferred or optional. Every unit ships complete — implementation + tests + docs — at the "holy shit, that's done" bar; the decomposition below is ordering a complete delivery, not a menu. The only sanctioned "not now"s are genuine external dependencies, stated honestly: (a) the MuQ sonic term activates on the `fluncle-embed` cron's timeline, not ours — it ships wired, gated, and dormant rather than faked; (b) richer ground truth (per-track key on historical sets) requires an operator-run Rekordbox pass on the M2 — the diagnostics ship able to consume it the day it lands. Dangling threads this build ties off: extracting the pure Camelot tables out of the client-only `key-notation.ts`, the `rekordbox-tracklist.py` key/BPM emission gap, a committed ground-truth extract so the floor check runs in CI, and registering `/mix` in `@fluncle/registry` with its full fan-out.

## 0. Summary / the reframe

- **The two products are one operation at two search depths.** "What mixes out of this?" ranked against the archive is depth-1 search; "order these N findings" is the full path search over the same pairwise score. One pure scoring core (`mixability.ts`, sibling of `embedding.ts`), three consumers: the public rail, the operator's path search, and the diagnostics.
- **The engine's honest objective is CLEAN mixability, not Fluncle-likeness.** The panel ran the ground truth: over the real ordered transitions of mixtape `019.F.1A`, the Camelot sub-score averages **0.36 — statistically indistinguishable from random key pairs (0.3625)**, including a literal tritone move (B minor → F minor). Fluncle mixes liquid DnB on phrasing, intros/outros, and energy, not harmonic adjacency. So the engine does not claim to imitate him: it computes the well-defined DJ-doctrine objective (beatmatchable, harmonic-safe, sonically continuous) that a working junglist wants from a _finder_, weights are versioned product config rather than a fitted model, and validation is a characterization diagnostic, not a training target.
- **The signal reality decides what slice 1 actually is.** Measured on the operator's prod snapshot (56 findings; re-measure at build time): `key` 50/56 and genuinely discriminative; `bpm` 53/56 but near-constant in the folded band (170.0–174.8 — tiebreak-grade information); `embedding_json` 3/56 (dormant; the cron is draining `embedding_json IS NULL`); `features_json` (the DSP spectral vector) **56/56**. Slice 1 is therefore a **harmonic next-track finder with a dense texture tiebreak** — the Camelot term leads, the DSP feature vector orders inside key plateaus, and the MuQ term is wired but gated off until coverage clears a floor. Sold as exactly that, it is still the first similarity feature that fires archive-wide ("Close in sound" renders for only the ~3 embedded findings today).
- **Product A is a plate, not a tool.** `/mix` renders a chain of findings on one logbook plate, proposes candidates with reason chips (never a numeric score — crew-facing numbers are a SaaS tell), plays the chain through the shipped `/api/preview/<logId>` relay, and shares as `/mix?set=<ordered coordinates>` with a set-level OG unfurl card (the share IS the reach mechanism on Discord/Telegram).
- **Product B proposes, never publishes.** `get_mixable_order` is a pure admin-tier read (open-path search: Held-Karp exact ≤16, multi-start greedy + 2-opt above) whose output is a copy-paste proposed tracklist handed to Rekordbox; `promote_recording` remains the sole, operator-gated mint. Its output is a _smoothness-optimized chain_, not an energy-shaped set — stated honestly, with the energy-arc term recorded as the designed extension.

## 1. Context & goals

Fluncle's archive already stores the three things a working DJ pays software to know about a track: musical key (`tracks.key`, scale text from the DSP), tempo (`tracks.bpm`, folded into the DnB band at write time), and what it sounds like (`tracks.features_json` today, `tracks.embedding_json` as the cron drains). Nothing yet connects them into the question a junglist actually asks: _what mixes out of this?_

Goals, honestly calibrated:

- **In reach now:** a correct, tested, deterministic mixability core; a public `/mix` set-builder with shareable set links; an operator dream-weaver that orders a candidate pool; a diagnostics artifact that characterizes the engine against Fluncle's real sets and prints its own honesty numbers.
- **Directional, on external timelines:** the MuQ sonic term becoming the lead signal (the embed cron's schedule); richer ground truth from the M2 Rekordbox re-extraction; the archive growing to where a set-builder's combinatorics feel deep (at 56 findings a typical tail has maybe 5–15 clean next-moves — the operator decides the launch posture, Decision 1).
- **Outside our control:** whether the crew shares set links. We build the loop; reach is earned.

## 2. Unit 1 — the shared scoring core

New pure module `apps/web/src/lib/server/mixability.ts`, sibling of `apps/web/src/lib/server/embedding.ts` (same posture: no I/O, exhaustively unit-tested, deterministic tie-breaks), plus one extraction it depends on.

### 2.0 Prerequisite extraction: the pure key/Camelot module

`apps/web/src/lib/key-notation.ts` holds the canonical `PITCH_CLASS` table (sharp + flat, ASCII + Unicode accidentals) and the `CAMELOT_MAJOR`/`CAMELOT_MINOR` maps — but they are module-private consts inside a **React client localStorage store** (`useSyncExternalStore`, exports only `formatKey`/`useKeyNotation`/…), so the server core cannot import it and `formatKey` returns display strings, not structure. Extract the tables + a named parser into a new pure shared module (e.g. `apps/web/src/lib/key-camelot.ts`) exposing `parseKey(text) → { pitchClass, isMinor } | null` and `toCamelot(pitchClass, isMinor) → { n, letter }`; re-implement `key-notation.ts` on top (its existing `key-notation.test.ts` must stay green — this touches the admin key chips, a small but real blast radius). The parser stays tolerant (`major|minor|maj|min`, enharmonic folding `Bb → A#` per the repo's sharp convention established in `packages/skills/fluncle-key-backfill/scripts/key_backfill.py:normalize_key`); unparseable or NULL key → the harmonic sub-score is `null`, never 0.

### 2.1 Inputs and the data reality

All inputs live on the one flat `tracks` table (`apps/web/src/db/schema.ts`) and all are nullable:

- `key: text("key")` (line 106) — scale text `"A minor"` / `"F# major"`, sharp spelling; honest NULL below the DSP's `KEY_CONFIDENCE_FLOOR = 0.6` (`packages/skills/fluncle-track-enrichment/scripts/analyze-track.ts:835`); repairable only by the manual `fluncle-key-backfill` Rekordbox pass. Snapshot: 50/56.
- `bpm: real("bpm")` (line 55) — already folded into the 160–185 DnB band at write time by `foldToBand()` (`analyze-track.ts:576–586`; AcousticBrainz-by-ISRC fallback exists); the snapshot confirms every stored value sits in 170.0–174.8. Snapshot: 53/56.
- `embedding_json: text` (line 94) — a 1024-d L2-normalized MuQ vector as a JSON array (`EMBEDDING_DIMS = 1024`, `embedding.ts:14`); `embedding_json IS NULL` is the embed cron's queue. Snapshot: **3/56** — the term is dormant at launch and the core must not lean on it.
- `features_json: text` (line 96) — the DSP spectral feature vector, internal analysis fuel, **56/56 present**. Dense enough to order inside key plateaus today (see 2.4b).

Snapshot numbers come from the operator's local `db:pull-prod` copy; `apps/web/.dev/` is **gitignored** (`docs/local-database.md`: "local database + snapshot (gitignored)"), so nothing in CI may assume it exists — see 2.6 for what gets committed instead. Do not build on the retired `vibe_x`/`vibe_y` columns.

### 2.2 The harmonic sub-score (Camelot)

A Camelot code decomposes to `(n ∈ 1..12, letter ∈ {A minor, B major})`. With circular distance `dn = min(|n₁−n₂|, 12−|n₁−n₂|)`:

| Relationship                   | (dn, letter) | Score |
| ------------------------------ | ------------ | ----- |
| Same key                       | 0, same      | 1.00  |
| Relative major↔minor           | 0, diff      | 0.90  |
| Adjacent (perfect fifth)       | 1, same      | 0.85  |
| Energy boost/drop (whole tone) | 2, same      | 0.60  |
| Diagonal                       | 1, diff      | 0.55  |
| 2, diff                        | 2, diff      | 0.35  |
| dn=3                           | 3, any       | 0.25  |
| dn=4                           | 4, any       | 0.15  |
| dn=5                           | 5, any       | 0.10  |
| Tritone                        | 6, any       | 0.05  |

One exported const table. Camelot is 24 genuinely discrete classes, so a lookup table is right and a continuous function would be false precision; the panel's tuning nits (the +2 energy move is arguably closer to the 0.85 adjacent than 0.60 in modern practice; dn=1-diff lumps two musically distinct diagonals) are recorded here as knobs, not errors — and moot until key demonstrably predicts anything for this operator (see 2.6). The ±2 move scores symmetrically; direction/energy is a sequencing concern (2.7), not pairwise compatibility.

### 2.3 The BPM sub-score (band-contract percent delta)

Stored BPM is folded into [160,185] at write time, so the core **asserts that band as an input contract** rather than re-folding: an out-of-band value yields a `null` sub-score plus a flagged input (never a silent mis-score). The panel killed the earlier "defensive octave fold" idea twice over — for in-band pairs `min(|a−b|, |a−2b|, |2a−b|)` always reduces to `|a−b|` (dead code), and on the one input that would trigger it (a stray 87 vs a 174) it would silently declare a half-time pair identical, which is exactly the relationship a DJ wants _named_, not erased. Cross-band/half-time scoring is out of scope by construction of the archive and stated as such.

Delta in percent against the slower tempo (`pctDelta = |a−b| / min(a,b)`), because the beatmatch window is a pitch-fader percentage (CDJ default ±6%). Piecewise-linear curve, knees exported: ≤1% → 1.00; 1–6% → linear 1.00→0.50; 6–10% → linear 0.50→0.00; >10% → 0.00 (a 160-vs-180 pair at 12.5% is unbeatmatchable and now scores 0, correcting the draft's over-generous tail). NULL BPM → `null`.

### 2.4 The sonic sub-score (MuQ cosine, gated + fixed calibration)

Reuse `cosineSimilarity` and the parse/validate path from `embedding.ts` verbatim. Two panel-forced corrections replace the draft's per-query min-max (which was NaN-prone at n=1, a forced {0,1} coin-flip at n=2, manufactured a "perfect match" out of any all-distant candidate set, and — via the renormalizing combiner — _systematically demoted the few findings that have embeddings_, punishing enrichment):

- **One fixed affine calibration for both products:** `sonicScore = clamp01((cos − LO) / (HI − LO))`, with `LO`/`HI` two named, versioned constants set from the archive's global pairwise-cosine distribution (5th/95th percentile) by a checked-in bootstrap script.
- **A coverage gate:** until the archive holds at least `MIN_EMBEDDED_PAIRS = 50` embedded pairs (a named constant; 3 embedded findings = 3 pairs today, so a percentile of them is garbage), the sonic term returns `null` for every pair and renormalization carries key+BPM. The gate lifts and the bootstrap runs as one deliberate, logged step when the embed cron gets there — no code change, no recompute chore before then.

Key and BPM are mechanical mixability; MuQ cosine is aesthetic continuity (liquid vs neuro at the same 8A/174) — and per the ground truth (2.6) it is the term most likely to reflect how Fluncle actually sequences, which is why it ships wired rather than cut.

### 2.4b The texture tiebreak (`features_json`)

Slice-1 scores would otherwise be the Camelot table's ten discrete values with BPM near-constant: huge tie plateaus broken by insertion order — a rail that feels canned to exactly the junglist it wants to impress. The DSP spectral feature vector is present on 56/56 findings, so Product-A ranking uses **deterministic feature-vector distance as the secondary sort inside equal-score plateaus** (then index, mirroring `rankBySimilarity`'s stable tie-break). It is a tiebreak, not a weighted term — its scale and semantics are DSP-internal and unvalidated as a similarity metric; promoting it to a fourth weighted term is an open question (Decision 4), and it never surfaces in copy or chips.

### 2.5 The combiner (present-term renormalization)

```
mixability(a,b) = Σ wᵢ·scoreᵢ / Σ wᵢ·[scoreᵢ ≠ null]     over i ∈ {key, bpm, sonic}
```

A finding with no key is scored on what it has, at full scale; all-null → `null` and the pair is excluded from ranking (Product A) or costed neutrally and flagged (Product B, 2.7). Shipped weights: `w_key = 0.50, w_bpm = 0.15, w_sonic = 0.35` — a **product choice, not a fitted model** (see 2.6 for why fitting is impossible and imitation is the wrong target): key leads because it is the dense discriminative axis and the objective is harmonic-clean; BPM is low because the folded band makes it near-constant (tiebreak-grade); sonic carries real weight for the day its gate lifts. One exported versioned const whose comment names this provenance.

The core also returns each pair's **dominant present sub-score as a structured reason** for the surfaces to render. The reason schema is part of the public contract, so it is pinned here (zod, in `packages/contracts/src/orpc/_shared.ts`):

```ts
const MixReasonSchema = z.object({
  kind: z.enum(["key", "bpm", "sonic"]),
  relationship: z.enum([
    "same_key",
    "relative",
    "adjacent",
    "energy",
    "diagonal",
    "distant",
    "tempo_match",
    "close_in_sound",
  ]),
});
```

### 2.6 Diagnostics, not a fit (the ground truth said no)

The draft planned a weight fit (231-point simplex grid + coordinate descent + LOO) against Fluncle's own published sets. The panel ran the data and the plan does not survive it:

- Joining the 17 `019.F.1A` fixture tracks to the archive: **1/17 embedded → 0/16 transitions carry a sonic sub-score** (the `w_sonic` axis is unfittable); fixture BPM spans 170.09–173.48, under 2% total (the `w_bpm` axis is flat); 3/17 keyless. What remains is ~10 key-scored transitions.
- Scoring those 10 real transitions with the Camelot table: **mean 0.36 vs 0.3625 for uniform random key pairs** — chance, including a tritone (B min → F min, 0.05) and two dn≥4 moves. Fluncle mixes on phrasing and energy, not harmonic adjacency. Fitting weights to imitate him would _reject_ the key term the product is built on.
- Whole-archive MRR is contaminated anyway: the other 15 members of the same curated set are near-perfect decoys, so even a flawless engine ranks "wrong."

So slice 1 ships **diagnostics that characterize, with the weights as config**:

- **A committed ground-truth extract** — `{ logId, key, bpm, hasEmbedding }` for the 17 fixture tracks (17 rows; keys/BPMs are already public on every track chip, no secret or topology) — generated by a checked-in script the operator runs against the local DB (the DB itself is gitignored and CI-invisible). A vitest unit test runs the **floor check** on this fixture pure (real-transition score distribution vs a seeded-random-pair distribution) so it lives inside `deploy:gate` without needing a database.
- **A bun diagnostic script** (outside vitest) against the provisioned dev DB printing: the floor-check distributions; the within-set successor rank (rank the true next among remaining unplayed set members — the uncontaminated pool) with the random baseline printed beside it for interpretation; and the join-coverage honesty numbers (how many fixture tracks carried key/embedding at run time).
- **The recorded finding** above, verbatim, in the script's header — so no future session re-invents the fit.
- **Ground-truth widening:** extend `packages/skills/fluncle-mixtapes/scripts/rekordbox-tracklist.py` to also emit `content.Key.ScaleName` and `content.BPM` (it currently emits label + order only; the fields are on the same `content` object it already walks). Rides Unit 1's PR; the operator's historical re-extraction on the M2 is scheduled separately (Decision 7). Fit machinery returns only if ≥3 keyed sets plus a live sonic term ever make the weights identifiable — and even then as characterization, since imitation is not the objective.

### 2.7 Path search (Product B's engine, still pure)

Cost `c(a,b) = 1 − mixability(a,b)`. Ordering N candidates is open-path TSP:

- **N ≤ 16:** Held-Karp exact DP. Implementation is mandated, not suggested: flat typed arrays (`Float64Array` DP table ≈ 8.4 MB at N=16 + parent table) indexed by integer bitmask — never string-keyed Maps (the naive transliteration blows the Worker budget); the N×N cost matrix precomputed once with each embedding parsed exactly once.
- **17 ≤ N ≤ 64:** multi-start greedy nearest-neighbor (every start, index order) + 2-opt capped at N passes, keep best. The input schema enforces `.min(2).max(64)` (a 65-id request 4xxs at validation).
- **Endpoints, corrected:** the free-both-endpoints default uses the zero-edge dummy-node trick (add a dummy connected at 0 cost to all, solve the cycle, delete it — its neighbors become the open ends); a **pinned start needs no dummy** — run the DP from the fixed vertex and take the min over end states. (The draft had this inverted.)
- **Null pairs cost the neutral median edge cost and the transition is flagged in the output** — max-cost would exile data-poor findings to the path ends, a data-availability artifact masquerading as musical judgment.
- **Fully deterministic:** no RNG; ties by cost then index.
- **Honest naming:** a symmetric cost minimizes total adjacent roughness — the output is a smoothness-optimized chain, not an energy-shaped set (open → build → peak → comedown), and the admin copy says so. The designed extension is an asymmetric energy-arc term once an energy proxy is sanctioned (`features_json` is the candidate; Decision 4/6 territory); the cost-function signature leaves room without API change.

### 2.8 Unit-1 acceptance

- `key-camelot.ts` extraction with `key-notation.test.ts` green and new parser tests (enharmonics, `Am`-style forms, junk, NULL).
- `mixability.test.ts`: the full Camelot table, the BPM band contract + curve knees (incl. 160-vs-180 → 0 and out-of-band → null+flag), the sonic gate (below-floor → null; above-floor affine map incl. clamp), the texture tiebreak determinism, renormalization (each single-null + all-null), reason selection, and path search (exact-vs-heuristic agreement on small N, pinned vs free endpoints, null-pair neutrality, determinism, the 64 cap).
- The committed extract fixture + its generator script; the floor-check unit test green in CI; the diagnostic script documented and run once, its output recorded in the module header alongside the weights' provenance.
- `rekordbox-tracklist.py` emitting key/BPM, its skill doc updated.

## 3. Unit 2 — Product A: `/mix` (public)

A **plate** — one printed logbook page over the cover backdrop — never a SaaS builder (PRODUCT.md's anti-references name this exact trap). The crew-facing sibling of Fluncle's mixtape-dream: to Fluncle a mixtape is him dreaming; a `/mix` set is the crew taking the decks with his findings.

### 3.0 Design invariants (gates, not aspirations)

The panel found the draft name-checking rules its own layout broke; these four are Unit-2 review gates:

1. **One sun.** The per-row Add on the candidate rail is a _quiet_ control (ghost/outline, Gold Veil on hover per the Ignition Rule) — a rail of gold Add buttons is eight suns. Exactly one Eclipse Gold primary exists on the plate (the player's play or "Copy set link" — pick one).
2. **No numeric score ever reaches the crew.** The public DTO carries ordered candidates + a reason chip, period — `get_similar_findings` (the claimed precedent) exposes no score either, and mono-genre compression guarantees clustered percentages that read broken. `transitionScore` numbers exist only on the admin surface.
3. **A new builder-row variant, not `TrackRow`.** `TrackRow` is a stretched-`::after` navigation atom (the whole row links to `/log`); a candidate row's primary action must be Add and a chain row hosts remove + reorder — four intents can't fight one stretched link. Borrow the `TrackRow` grid skeleton (Log ID column, 3.25rem artwork, title, chip row) and `TrackChips` for the reason chip; drop the stretched-link behavior.
4. **The phone stack is decided:** chain = the plate body (vertical, reorder via keyboard-accessible up/down buttons — no drag dependency); candidate rail = a disclosed section below the chain (no side rail on a phone); player = a slim bottom-pinned strip reusing the stories progress-clock pattern. One pane throughout; nothing stacks glass on glass.

Also: the masthead nameplate slot takes a noun, not an imperative ("Build a set" as Oxanium display is off-pattern — keep a quiet h1 or find the noun in the copy pass), and the `/log` entry point is a quiet secondary beside `SaveFindingButton` (`log.$logId.tsx:384`), never a second gold action.

### 3.1 The API surface

- **`list_mixable_tracks`** — `GET /tracks/{idOrLogId}/mixable`, operationId `listMixableTracks`, public unauth, modeled on the shipped `get_similar_findings` (`packages/contracts/src/orpc/tracks.ts`). Input `{ idOrLogId: string, limit?: string, exclude?: string }` — `exclude` is a comma-separated logId list so **already-chained findings are excluded server-side** (client-side-only exclusion would let a 10-deep chain in a small archive silently empty the rail and show "Quiet sector" for a false reason). Output `{ ok: true, findings: MixableCandidateSchema[] }` where `MixableCandidate = TrackListItem & { reason: MixReason }` (schema in 2.5) — ordered by the core, no score field.
- Handler in `apps/web/src/lib/server/orpc/tracks.ts` calling a new `getMixableTracks(idOrLogId, { limit, excludeLogIds })` in `tracks.ts` (same shape as `getSimilarFindings:764`: target lookup → one candidate scan over `log_id IS NOT NULL` rows selecting `key, bpm, embedding_json, features_json` → core scoring + tiebreak → hydrate via `getTracksByIds`).
- Coverage bookkeeping (build-fails if skipped): the route into `orpc-coverage.test.ts` `PUBLIC_ROUTE_OPS`, the op into `orpc-auth-coverage.test.ts` `PUBLIC_UNAUTH_OPS`; `orpc-naming.test.ts` passes (`list` is in `APPROVED_VERBS`, verified).
- **Compute-on-read, no cache** — one archive scan, the same cost profile as the uncached `get_similar_findings`; brute force is blessed in the code's own comments to low thousands. §5 records the future-cache posture. **Rate limiting is Decision 3** — this is the repo's first public interactive compute endpoint and `apps/web` has no rate limiting anywhere today.

### 3.2 The route and deep-link

`apps/web/src/routes/mix.tsx`. URL: **`/mix?set=241.7.3A,242.1.1B,243.4.2C`** — ordered comma-separated finding coordinates (findings only; a mixtape is Fluncle's own object — Decision 5 ratifies). `validateSearch` splits, trims, filters through the shipped `isLogId` guard (`apps/web/src/lib/log-id.ts`), caps at 32, drops junk without a DB hit. Route options in TanStack canonical order with `// oxlint-disable-next-line sort-keys`; `loaderDeps` on `set`; the loader hydrates **cold-load only** in one `getTracksByLogIds` query (`tracks.ts:292`, an unordered Record the loader re-orders to the URL; vanished coordinates drop silently). **Chain edits are client state**; the URL syncs via masked replace navigation with `shouldReload: false` — a raw `replaceState` wipes TanStack's `__tempLocation` and a naive navigate re-runs the loader on every reorder click (both are documented repo traps).

`head()` emits the canonical URL, `MusicPlaylist` JSON-LD of `MusicRecording` members (the homepage precedent), and — **in scope, not polish** — a set-level OG image: the existing `api/og/$logId` generator is single-finding-only, and a `/mix` link that unfurls as a naked URL on Discord/Telegram (where the crew lives) has no working share step. Add `api/og/set` rendering the chain's covers + count in the same visual system.

A shared link renders **read-only** (the chain, playable, no rail) with one action — "Chain your own set from here" — that promotes it into the editable builder. There is no server-side set persistence; the link is the object.

### 3.3 The interaction

1. **Start from any finding:** the quiet `/log` entry seeding `/mix?set=<logId>`, or `/mix` cold with the empty state and a `command`-combobox picker.
2. **The archive proposes:** the rail off the chain's tail via `list_mixable_tracks` (excluding the chain), each candidate a builder-row with its reason chip (`Same key`, `+2 BPM`, `Close in sound` — final strings via the copywriting pass) and a quiet Add.
3. **The chain grows:** ordered builder-rows, per-row remove + up/down, Log ID coordinates framing every entry; each edit recomputes the rail and syncs the URL.
4. **Play the set:** one `<audio>`, `src=/api/preview/<logId>` — the shipped live relay that re-resolves on demand because stored preview tokens expire (order: stored URL → Deezer-by-ISRC → iTunes; open CORS; Range-capable; `no-store`). Advance on `ended`, copying `stories-player.tsx`'s patterns: gesture-gated sound unlock, per-segment progress strip off the audio clock, reduced-motion → manual advance only. A straight cut between 30s previews is honest; no fake crossfade. A finding with no resolvable preview plays as a skip.
5. **Share:** "Copy set link" via the shipped `navigator.share` → clipboard fallback, confirmed by a sonner toast.

Voice: all strings through the copywriting-fluncle skill (dry, first-person selector, no exclamation marks, Garnish only where there's room, sentence case). The panel's corrected empty-rail string shows the pattern: _"Nothing keys up cleanly to this one yet. Quiet sector."_ — the shipped "Quiet sector" idiom is a terminal tag, never mid-sentence, and prose never takes an em dash. Degradation is narrative, never broken UI: a keyless tail scores on what it has (the renormalizing core) and the chips say so honestly; WCAG AA, full keyboard access, reduced-motion collapses motion to color.

### 3.4 Surface registration

Register `/mix` in `@fluncle/registry` per the fluncle-surfaces skill and walk the full fan-out (status probe, homepage dev-row/nav, llms.txt, sitemap, surfaces-doctrine doc). Recommended weight: **listed, not prominent** — the archive of findings IS the page; /mix's value is the shareable link, not homepage real estate (Decision 1 sets the launch posture).

### 3.5 Unit-2 acceptance

- Contract + handler + coverage entries green; `getMixableTracks` unit-tested (ordering incl. plateau tiebreak, exclusion, degradation, limit, empty).
- Route tests: `validateSearch` (junk dropped, cap), loader order preservation, read-only vs builder promotion; the OG set card renders.
- Browser verification past hydration (house practice) including reduced-motion, keyboard reorder, and the design-invariant gates in 3.0; a canon review against DESIGN.md/VOICE.md as a merge gate.
- Registry fan-out complete; copy ratified via the voice pass; the rate-limit decision implemented or its acceptance-of-risk recorded.

## 4. Unit 3 — Product B: the dream-weaver (operator)

The persona law (docs/admin-shell.md) places it: web admin is the operator's platform, `fluncle admin` is the agents' tool. The panel split on proportionality (a task performed every few weeks vs a full admin build); the synthesis: the **op + CLI are the durable automation and ship unconditionally; the admin page ships thin** — no new primitives (Decision 6 ratifies).

### 4.1 The op — a pure read, structurally

- **`get_mixable_order`** — **`GET /admin/tracks/mixable-order?ids=<logId,…>&seed=<logId>`**, operationId `getMixableOrder`, admin tier (`adminAuth`, agent-allowed like `get_track_admin`; no `operatorGuard` because it cannot write). GET, not POST: all 17 existing `get_*` ops are GET, and 64 comma-joined logIds (~700 chars) fit a query param comfortably — no reason to mint the repo's first POST-`get_*`. Input zod: ids `.min(2).max(64)`, validated logIds. Output `{ ok: true, order: [{ logId, title, artists, key, bpm, transitionScore, transitionReason, flagged }...], totalCost, algorithm: "held-karp" | "greedy-2opt" }`.
- **Zero writes, structurally:** the handler imports only read paths + the pure core — never `updateTrack`/`promoteRecording`/any publish surface. Coverage bookkeeping: `ADMIN_ROUTE_OPS` entry (contract-only admin ops are precedented — the `drip_clips` pattern), `EXPECTED_TIERS: "admin"`. **`promote_recording` (operator tier) remains the only way a mixtape exists.**

### 4.2 The surfaces

- **CLI:** `fluncle admin tracks mixable-order <logId...> [--seed <logId>] --json` — a thin `adminApiGet` in `apps/cli/src/commands/admin-tracks.ts` + a Commander registration, printing the ordered proposal (human table / `--json`).
- **Admin page, thin:** the findings board has **no multi-select selection bar today** (admin-shell.md describes one abstractly; zero instances ship), and the dream-weaver must not smuggle in that whole new primitive. Instead: a panel with a coordinate input (paste a logId list, or seed from an existing board filter/worklist), one primary "Propose an order" header action, the result as the shared `ObjectList`/`ObjectRow` primitives (`components/admin/object-row.tsx`, verified real) with per-transition score/reason as quiet right-aligned meta and flagged (null-pair) transitions marked, and a "Copy tracklist" action (`Artist — Title` per line — the established admin clipboard pattern) pasted into Rekordbox on the M2 as advisory input. The admin copy names the output honestly: a smooth chain, not an energy-shaped set.

### 4.3 Unit-3 acceptance

- Contract + handler + coverage entries green; handler test proving output order matches the core on a fixture set, the 64-cap 4xx, and clean faults on unknown logIds.
- Admin page exercised via the shell browser-verification fixtures (`loginAsAdmin`); clipboard verified.
- CLI verified live against a dev server (`--json` smoke); documented in CLI help.
- Docs: the proposal step noted in the fluncle-mixtapes skill runbook (before the operator's Rekordbox session); naming-conventions registry rows for both ops.

## 5. Caching & scale posture

Slice 1 is compute-on-read everywhere — one archive scan (A) or an O(N²) pure computation over ≤64 operator-picked findings (B); Turso round-trips dominate wall-clock, not arithmetic. When scale demands more (past ~10k findings, or measured latency), the repo's grain says no KV binding (`wrangler.jsonc` binds only the two R2 buckets; Turso rides HTTP + env, not a binding — and no KV/D1/DO precedent exists). In order of fit: (1) libSQL native `vector_top_k` replaces the brute-force embedding scan (the escape hatch `embedding.ts` itself names); (2) a derived Turso table of per-finding candidate lists keyed by a version token; (3) `caches.default` with a synthetic versioned URL, purged best-effort like `purgeVideoCache`. Invalidation has exactly one siting: `key`/`bpm`/`embedding_json`/`features_json` all mutate through `updateTrack` (`track-update.ts`) — including the Rekordbox key-backfill — so one hook there covers everything. Recorded so the future change is mechanical, not a re-design.

## Sequencing & ownership

1. **Unit 1 first** — pure, zero UI risk, unblocks everything. Its first artifact is the committed-extract floor check: the ground truth's verdict (key-at-chance for set 1) is already known and baked into the objective framing, so the check is a regression pin, not a suspense gate.
2. **Units 2 and 3 parallelize** after Unit 1 merges (disjoint files, both read-only consumers). Worktree sub-agents open PRs per the agent-orchestration doctrine (worktree agents branch from origin — push Unit 1 first); merges spaced per the Cloudflare build-coalescing rule; a canon review gates Unit 2.
3. The `rekordbox-tracklist.py` extension rides Unit 1; the M2 historical re-extraction and the sonic-gate bootstrap are operator-scheduled follow-ons the code is already shaped to receive.

## Decisions

Ratified by the operator, 2026-07-10:

1. **`/mix` launch posture: ADMIN-GATED until an archive floor (~250+ findings).** Build the full surface but behind admin auth; going public later is flipping the gate + registry weight + the announcement, not a rebuild. The empty-rail state still ships (the operator sees it while dogfooding).
2. **Rate limiting: accept-risk, no limiter.** One bounded scan comparable to existing uncached reads; the posture is recorded in the handler comment and revisited at archive growth. (Moot for slice 1 while /mix is admin-gated; ratified so the public flip needs no new decision.)
3. **`features_json` is SANCTIONED as the in-plateau tiebreak.** Graduation to a weighted term or the energy-arc proxy is a separate, later decision.
4. **The thin admin page ships in slice 1** alongside the op + CLI (persona law).

Still open (none block the build):

5. **Ratify the copy register** — the feature's name (the masthead noun), the chip strings, the empty states — via the copywriting-fluncle pass + the operator's morning taste review. Gates Unit 2's public strings only; admin-gated dogfood copy ships under the canon review.
6. **`?set=` membership and cap:** findings only, cap 32 — building on the draft position; flag at review if it chafes.
7. **Approve the `rekordbox-tracklist.py` key/BPM emission and schedule the M2 historical re-extraction** — the only ground-truth widening lever, operator-run by definition.
8. **Confirm the sonic-gate shape:** `MIN_EMBEDDED_PAIRS = 50` and the bootstrap-once-then-versioned-constants flow — building on the recommendation; flag at review if it chafes.

## Acceptance criteria (ship-gates)

- All unit-level acceptance in 2.8 / 3.5 / 4.3.
- The floor-check unit test green in CI off the committed extract; the diagnostic script's output recorded in the core's module header with the weights' provenance.
- `bun run typecheck`, `bun run check`, `apps/web` build + lint, CLI typecheck + live `--json` smoke, all green; `deploy:gate` green on the final push; the fluncle-smoke sweep passes post-deploy.
- Not ship-gates (monitored outcomes): embedding coverage %, the sonic-gate lift date, set-link share counts.

## Risks & open questions

- **Slice-1 identity risk, stated bluntly:** the differentiator (MuQ sonic) is the one term that doesn't fire at launch, and BPM doesn't discriminate — slice 1 is a Camelot engine with a texture tiebreak. Honest framing ("a harmonic next-track finder") and the tiebreak keep it from feeling canned; the embed cron changes the engine without a code change.
- **The engine deliberately does not mix like Fluncle.** His real transitions sit at chance on the harmonic axis; the engine optimizes clean mixability instead. If the operator ever wants "order it like I would," that is a different (sonic/energy-led) objective gated on embedding coverage — recorded, not promised.
- **The SaaS-builder gravity well:** /mix is the first tool-shaped public surface; the 3.0 invariants exist because the default aesthetic of "builder UI" violates the canon. The canon review is a merge gate.
- **Snapshot staleness:** all coverage numbers are one machine's pull; re-measure at build time (the embed cron has been draining since 07-08).
- **Publish-boundary drift:** the dream-weaver must stay a proposal engine; any future "create recording from proposal" one-click re-opens operator-gating and needs its own decision.
- **Preview dependency:** chain playback rides Deezer/iTunes availability through the relay; skips are inherited, honest behavior.

## Appendix — panel verifications & sources

- **Ground truth run:** the 17-track `packages/video/src/set-video/__fixtures__/019.F.1A.tracklist.json` joined to the snapshot: 14/17 keyed, 1/17 embedded, BPM 170.09–173.48; the 10 fully-keyed real transitions score mean 0.36 on the Camelot table vs 0.3625 analytic random (incl. B min→F min = tritone 0.05; the one clean hit: E min→G maj relative pair 0.90).
- **Coverage (snapshot, 56 findings):** key 50, bpm 53, embedding 3, features_json 56; `apps/web/.dev/` verified gitignored (`.gitignore:5`, `docs/local-database.md`).
- **Verified exact:** schema lines (`bpm` 55, `embedding_json` 94, `features_json` 96, `key` 106, `log_id` 108); `EMBEDDING_DIMS`/`cosineSimilarity`/`rankBySimilarity` (`embedding.ts:14/71/104`); `getSimilarFindings` (`tracks.ts:764`, uncached, no score in its contract); `getTracksByLogIds` (`tracks.ts:292`, unordered Record); `isLogId` (`lib/log-id.ts:10`); preview relay order (`preview-live.ts`); "Close in sound" (`log.$logId.tsx:421`); `SaveFindingButton` (`log.$logId.tsx:384`); `ObjectList`/`ObjectRow` (`components/admin/object-row.tsx`); the four coverage tests + `APPROVED_VERBS` containing `get`/`list`; contract-only admin-op precedent (`drip_clips`); `adminApiGet/Post` (`apps/cli/src/api`); `KEY_CONFIDENCE_FLOOR`/`foldToBand` (`packages/skills/fluncle-track-enrichment/scripts/analyze-track.ts:835/576`); `rekordbox-tracklist.py` emits label+order only; "Quiet sector" as a shipped terminal-tag idiom (~12 uses).
- **Corrected from the draft:** the snapshot is NOT committed; `key-notation.ts` is a client React store with the tables module-private (extraction mandated); per-query min-max sonic calibration removed (NaN at n=1, {0,1} at n=2, demotes embedded findings under renormalization); the defensive BPM octave fold removed (dead in-band, wrong cross-band); whole-archive MRR demoted (curated-set decoys); the dummy-node endpoint description un-inverted; `wrangler.jsonc` binds two R2 buckets (Turso is HTTP+env, not a binding); all 17 `get_*` ops are GET → the order op goes GET; TanStack replace/`__tempLocation` and loader-rerun traps sited in 3.2.
- **External practice (2026):** Mixed In Key / DJ.Studio / djingpro Camelot guides; Mixgraph half-time & BPM references; HarmonySet (Held-Karp ≤20 + greedy/2-opt prior art); ISMIR 2017 playlist sequencing; Johnson & McGeoch on 2-opt.
