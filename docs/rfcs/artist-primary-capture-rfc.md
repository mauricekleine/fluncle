# RFC: artist-primary capture — authorization follows the artist, labels stay discovery

**Status:** In flight (ratified in conversation 2026-07-20; spike numbers below). Prune when shipped.
**Supersedes:** the `not-a-seed` four-state sketch (never built). Labels keep exactly the three states they have (`enabled` / `disabled` / `undecided`); no new label state ships.

## The model

Two axes, cleanly separated:

- **Discovery (crawl) is label-driven and unchanged.** `enabled` labels seed the walk; hop 1 follows every credited artist; hop 2 walks each artist's full discography on any label. An artist who moved from RAM to a major arrives by themselves — no ruling on the major needed, ever.
- **Capture (spend) is artist-driven.** A track's audio may be bought iff **(a credited artist is QUALIFIED) OR (its label is `enabled`)** — and never when its label is `disabled` (the existing veto, unchanged). Everything else (undecided labels, majors, generics) sinks to a new negative tier: metadata welcome, money withheld.

**QUALIFIED artist** = has a certified finding, **OR** weighted release count on `enabled` labels ≥ **3** (primary credit 1.0, `remixer` 0.5 — roles are sparse today, so weighted ≈ unweighted until the graph enriches), **OR** carries an explicit operator approval flag (the rare no-findings-yet escape hatch; can ship later). Matching is **by identity through the `track_artists` graph** (`artists.id`), never name-fold.

**Demotion:** `findingLabels` (a label carrying a finding) stops being an authorization rung — a finding lifts its ARTIST, never its label's neighbors (live counter-example: 1 Atlantic-UK finding currently lifts every crawled Atlantic-UK track to tier 2). It may remain a priority hint among already-authorized tracks.

**Per-track vetoes stay on top of authorization:** long-form, duplicates, wrong-audio — authorization spends, filters still filter.

## Spike numbers (prod snapshot 2026-07-20)

- Graph coverage: **12,312 / 37,465 tracks** carry `track_artists` edges (33%) — the graph is crawl-era-only. **Slice 0 (backfill) is the prerequisite.**
- Qualification curve (weighted, enabled labels): ≥1 → 1,751 artists · ≥2 → 982 · **≥3 → 769 (ratified)** · ≥5 → 534.
- At threshold 3: 24,836 of 26,288 uncaptured tracks stay authorized (bulk via enabled labels); **~1,450 tier-0 tracks lose eligibility** — the protected spend.
- Tier-2 overshoot today is small (18 uncaptured tracks: Armada 13, Atlantic UK 2, …) but grows with the hop-2 wave into major catalogues.

## Slices

- **Slice 0 — graph backfill (prerequisite):** fold `tracks.artists_json` names onto EXISTING `artists` rows (exact fold + `artist_aliases`), writing `track_artists` edges idempotently. No minting from bare names (an artist row is an entity with a page — a name string is not enough identity); report the unmatched residual, which decides whether a paced MusicBrainz credit-sweep follow-up is worth it.
- **Slice 1 — authorization core:** the qualified-artist set (precomputed, sweep-scale), the gate in `capturePriorityFor`'s caller path, `findingLabels` demoted, the new negative tier riding the existing `capture_priority >= 0` queue predicate, docs + tests.
- **Slice 2 (later) — preview-BPM gate:** free 30s-preview beat detection before capture; octave-folded acceptance (160–180 ∪ 80–90 ∪ ~320–360), reject only on a CONFIDENT out-of-band reading, no confident beat → pass (the piano-intro case). Analysis-only preview use; never feeds vectors (ratified canon).
- **Slice 3 (later) — catalogue cleanup pass:** retire tracks/artists that should never have entered (operator-scoped; define "shouldn't" against this model first — likely: unauthorized + off-genre-confident + no graph affinity).

## Decisions locked

Threshold 3 · identity-only matching · no new label state · undecided = artist-edge-only capture (the closed gate) · fail-open where confidence is absent.
