# Brief: BPM + key accuracy, and the preview-era backfill

Non-canonical planning (see AGENTS.md). Hand this to a fresh agent. Everything below is grounded in code or in measurements taken 2026-07-10; where something is a hypothesis it says so.

## The outcome we want

Know whether Fluncle's stored `bpm` and `key` are wrong, know _why_, fix the cause, and re-derive every finding that carries a stale value — with provenance recorded so this can never silently rot again.

## The evidence that opened this

Rekordbox (a DJ-beatgridded ground truth) was compared against the archive for the two tracks loaded on the decks:

| finding                                           | Rekordbox               | Fluncle            | delta                     |
| ------------------------------------------------- | ----------------------- | ------------------ | ------------------------- |
| `019.1.7X` Technimatic — Strength                 | 174.00 · `6A` (G minor) | 172.56 · `G major` | bpm −1.44, key mode wrong |
| `011.1.6E` Netsky — I See The Future In Your Eyes | 173.00 · `5A` (C minor) | 171.09 · `C minor` | bpm −1.91, key correct    |

The Camelot map is self-validated: `5A` is C minor and Fluncle independently stored `C minor`, so the map is right and `019.1.7X`'s mode disagreement is real.

Across the newest 48 findings every stored BPM sits in 170.0–174.82 with the mass at 171–173. Drum & bass centres on 174. **Both samples read low, and the whole distribution looks shifted low.** Two points is not a result — quantifying this is task 1.

## What the code actually does (grounded — this corrected the original hypothesis)

The original hypothesis was "bpm/key are preview-derived." That is **half wrong**, and the half that is wrong is the important half.

- The DSP lives in `packages/skills/fluncle-track-enrichment/scripts/analyze-track.ts` — `estimateBpm` (:652, onset-envelope autocorrelation folded to the D&B band), `estimateKey` (:533, Krumhansl-Schmuckler chroma correlation), `decodeToSamples` (:232, ffmpeg → mono 22050 Hz). The planned fold of this DSP into the `fluncle` CLI **did not ship**; the on-box runner spawns the skill script (`docs/agents/hermes/scripts/enrich-sweep.ts:46`).
- **Analysis already prefers full audio.** `enrich-sweep.ts:307-325` fetches `source_audio_key` from private R2 and passes `--audio-file`; only a missing key or a failed GET falls back to the 30s Deezer/iTunes preview (`analyze-track.ts:863` vs `resolvePreviews()` :118).
- **But there is no ordering guarantee.** Capture and enrichment are independent self-healing queues with no orchestrator (`docs/track-lifecycle.md:46`; `enrich-sweep.ts:317-321` states the enrich queue is capture-INDEPENDENT by design). A finding whose enrich tick fires before its capture tick is analyzed **from the preview**, permanently.
- **Nothing ever re-derives a real-but-wrong value.** `capture-sweep.ts:375` `needsBpmRederive` re-queues only null / non-finite / ≤0 BPM. A preview-derived `172.56` is never revisited when the full song later lands. Key is never re-triggered at all.
- **There is no provenance.** Schema carries only `bpm real` (`apps/web/src/db/schema.ts:55`) and `key text` (:106). The analyzer _emits_ `bpmConfidence`, `keyConfidence`, `bpmSource`, `keySource` (`analyze-track.ts:983-994`) and the write path **discards all four** (`apps/web/src/lib/server/track-update.ts:174,179`). Nothing records whether a row came from a preview or a full song, or when.

So new tracks are enriched from full audio **only if capture happened to win the race**. That is the first thing to verify empirically and the first thing to fix.

## Why some findings have no bpm / no key

This looked anomalous; it is mostly by design. Of the newest 48:

- **4 have no `bpm`.** One is `019.F.1A`, Fluncle's own mixtape — `enrichment_status` is null and it is never enriched. Correct, not a bug. The other three (`018.0.3G`, `024.7.2R`, `024.7.3Y`) are `status='done'` with key _and_ features present: the DSP returned a BPM below `BPM_CONFIDENCE_FLOOR = 0.15` (`analyze-track.ts:560`, applied :822) and the AcousticBrainz-by-ISRC fallback (:947, only fires when DSP bpm is null **and** an ISRC exists) did not rescue them.
- **5 have no `key`.** One is again the mixtape. The other four have bpm and features: the DSP fell below `KEY_CONFIDENCE_FLOOR = 0.6` (:835, applied :962). Key has **no** fallback below the floor — that null-key backlog is exactly what `packages/skills/fluncle-key-backfill` targets.

Honest nulls, then. Worth noting `032.0.6R` stores exactly `170` (an integer among floats) — likely the octave-folded AcousticBrainz fallback. Confirm.

## Task 1 — attribution (do this BEFORE any backfill)

**A backfill may fix nothing.** If the estimator itself is biased, re-deriving from full audio reproduces the same wrong numbers at greater cost. Findings added on 2026-07-08 (after capture shipped) still store 170.48–171.41 — consistent with _either_ a lost race _or_ a biased estimator. Disambiguate first.

Rekordbox gives ground truth at scale: the operator's collection substantially **is** the archive (dozens of overlapping titles). `master.db` carries both `DjmdContent.BPM` and `DjmdContent.Key.ScaleName`.

1. Build a ground-truth table by joining `master.db` to the archive. Reuse the matcher in `packages/skills/fluncle-key-backfill` — normalized title + artist, never ISRC, remix/VIP descriptors preserved as identity (`SKILL.md:121-130`).
2. For each overlapping finding, record: stored bpm/key, Rekordbox bpm/key, whether `source_audio_key` exists.
3. For a sample that **has** captured full audio, re-run `analyze-track.ts` twice — once with `--audio-file` (full song) and once forced down the preview path — and compare both against Rekordbox.

That yields the decisive answer:

- full-audio DSP is accurate, preview DSP is low → **stale rows.** Backfill fixes it. Proceed to task 2.
- full-audio DSP is _also_ ~1.5 low → **estimator bug.** Fix `estimateBpm` first (suspect octave folding and autocorrelation peak interpolation/resolution — a 22050 Hz mono onset envelope has finite tempo resolution and a systematic low bias smells like an un-interpolated argmax). A backfill before this fix would bake the error in permanently.

Do the same attribution for key mode, separately: mode confusion (`G major` vs `G minor`) is a chroma/profile issue, not a tempo one, and may survive a source upgrade.

## Task 2 — the durable fixes (regardless of what task 1 finds)

1. **Record provenance.** Persist the four fields the analyzer already emits — at minimum `bpm_source` / `key_source` and an `analyzed_at`, ideally `analyzed_from ∈ {preview, full}` plus the confidences. Migration via `bun run --cwd apps/web db:generate` (never hand-written). Without this, "which rows are stale?" stays unanswerable and the next backfill is another guess.
2. **Close the race.** Make capture landing after analysis re-queue the finding for re-derive. Today `needsBpmRederive` (`capture-sweep.ts:375`) only catches null/≤0. It should catch _any_ row analyzed from a preview when full audio now exists — which is trivial once provenance exists, and is the permanent fix for the whole class of bug.
3. **Delete the stale reference.** `capture-sweep.ts:372` claims the `fluncle-bpm-backfill` skill "still repairs the rare legacy fake"; that skill directory no longer exists.

## Task 3 — the backfill

Only after task 1 attributes the error and task 2 lands provenance.

- Enumerate the whole archive with `fluncle admin tracks list --limit <large> --json`, which walks the cursor chain (`apps/cli/src/commands/admin-tracks.ts:37`). The public `/api/tracks` caps page size and will not show all 60.
- Re-derive by draining a queue, the way the MuQ embed backfill did (`embedQueueCommand`, `admin-tracks.ts:169`) — a self-healing `WHERE analyzed_from = 'preview' AND source_audio_key IS NOT NULL` sweep, not a bespoke script. This is the house pattern.
- Write via the existing admin path: `fluncle admin tracks update <trackId> --bpm <n> --key "<k>"` → oRPC `update_track`. Key format is sharp-spelled `"<Note> major|minor"` (`analyze-track.ts:425,543,548`).
- Findings **without** captured audio cannot be repaired by re-derivation. Either capture them first, or accept the preview value. Say which; do not quietly skip them.
- `bpm` and `key` are public, user-visible fields rendered on `/log`, and are in `VISIBLE_FIELDS` (`track-update.ts:126`), so a backfill bumps `updated_at`. Expect feed/sitemap churn; that is acceptable but should be a deliberate, single sweep rather than a drip.

## Rails

- Production data. The write path is the authenticated admin API; a dry-run diff reviewed by a human precedes any `--apply`, exactly as `fluncle-key-backfill` does.
- `master.db` belongs to the mixing machine per AGENTS.md. A Rekordbox library also exists on the build machine; confirm with the operator which library is authoritative before trusting a ground-truth join, and note the build-machine collection may be a subset.
- Do not "fix" a disagreement by trusting Rekordbox blindly on key. Rekordbox's own key detection is not infallible; where DSP and Rekordbox disagree on **mode** with high DSP confidence, flag rather than overwrite.
- Never write a value the DSP reports below its confidence floor. An honest null beats a confident wrong number.

## Open questions for the operator

1. Is the Rekordbox library on the build machine authoritative, or is the mixing machine's `master.db` the only ground truth?
2. When DSP and Rekordbox disagree on key mode, who wins?
3. Backfill scope: every captured finding, or only those provably preview-derived once provenance exists?
