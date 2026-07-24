// THE EAR — the catalogue's ranking engine (docs/the-ear.md).
//
// A CATALOGUE TRACK is a row in `tracks` with NO row in `findings`: a track Fluncle knows
// about and has not certified. The Ear ranks them by ONE question — how close is this to
// something he already loves? — and `/admin/catalogue` reads that ranking back.
//
// ── WHY THIS IS A SWEEP AND NOT A QUERY ──────────────────────────────────────────────
// The naive version ("rank the catalogue against the findings when the page loads") is a
// CROSS JOIN. At 10k catalogue rows × 60 findings that is 600,000 1024-dimension cosine
// operations PER PAGE LOAD, and the vectors are 4 KB each. It does not get slow; it dies.
//
// So the arithmetic happens ONCE, ahead of time, in a periodic sweep (`rankCatalogue`),
// exactly like the cluster engine's nightly assignment tick (docs/agents/cluster-engine.md):
// the sweep computes each catalogue track's nearest finding and STORES it on the row, and
// the surface then does an indexed read of a precomputed number. There is no vector math
// on the request path at all.
//
// ── THE RANKING: MAX-SIMILARITY TO ANY FINDING, NEVER TO A CENTROID ───────────────────
// A candidate's score is its cosine similarity to its single NEAREST finding. Not to the
// mean of the findings: the operator's taste is multi-modal (the k=4 galaxy fit found four
// regions he could name by ear), and the mean of four regions is a place none of his taste
// actually lives. A liquid roller must be allowed to win on the liquid findings alone.
//
// ── AND EVERY ROW CARRIES ITS WHY ────────────────────────────────────────────────────
// `nearest_finding_track_id` is stored alongside the score because a bare number is not a
// reason. "0.91" tells the operator nothing; "because you logged Krakota — See For Miles"
// tells him whether to trust the instrument. A telescope he cannot interrogate is one he
// stops looking through.
//
// ── THE THREE DATABASE RULES, ALL LOAD-BEARING (docs/local-database.md) ───────────────
//   1. RANK IN SQL. `vector_distance_cos(candidate.vec, finding.vec)` runs in the database
//      and only the winners come back — two scalars per candidate. Pulling the vectors into
//      the isolate to rank them is what OOMs the 128 MB Worker.
//   2. Both sides of the distance are STORED BLOB COLUMNS, never a bound text vector. (The
//      14× text-probe cliff is about BINDING a probe; there is no probe here — this is a
//      column-to-column join, which never re-parses anything.)
//   3. NO ANN INDEX. `libsql_vector_idx` wedged hosted Turso's write path for 20+ minutes
//      in the spike. The exact scan is the ratified shape, and here it is bounded to
//      `batch × findings`, which is the whole point of the batching.
//
// ── THE CHICKEN-AND-EGG, AND WHY `capture_priority` EXISTS ────────────────────────────
// A catalogue track has no vector until its full audio has been captured, and capture is
// metered — we will not capture everything. So the Ear's score CANNOT be what prioritises
// capture: the tracks that most need capturing are precisely the ones with no score yet.
// `capturePriorityFor` is the pre-audio answer — the cheap metadata signals that genuinely
// correlate with "Fluncle would like this", available before a single byte is downloaded.
// It is the capture queue's sort key, and it is deliberately a small, explainable ladder
// rather than a model: the operator has to be able to see why a track is next.

import { type InStatement } from "@libsql/client/web";
import { parseArtistsJson } from "./artists";
import { getDb, typedRow, typedRows } from "./db";
import { labelSlug } from "./labels";
import { getSetting, setSetting } from "./settings";
import { matchKey } from "./track-match";

// ── The pre-audio capture ladder ─────────────────────────────────────────────────────

/**
 * The reason a catalogue track sits where it does in the CAPTURE queue — the row's WHY,
 * before it has any audio to measure. `kind` is the ladder rung; `name` is the thing that
 * matched (the artist, or the label), and is null for the reasons that name nothing (`none`,
 * `unauthorized`).
 *
 * ── AUTHORIZATION VS PRIORITY (RFC artist-primary-capture, slice 1) ────────────────────
 * Two questions live here, and they are cleanly separated. AUTHORIZATION — may we spend a
 * metered per-GB byte on this row at all? — is artist-driven: yes iff a credited artist is
 * QUALIFIED (identity, through the `track_artists` graph) OR its label is `enabled`. PRIORITY
 * — among the rows we MAY buy, who first? — keeps the old explainable ladder as an ordering
 * hint. A row that fails authorization lands `unauthorized` (a negative tier, excluded from
 * the capture queue by the existing `capture_priority >= 0` predicate); a `disabled` label is
 * still the harder `skipped-label` veto, checked first.
 */
export type CapturePriorityReason = {
  kind: "artist" | "label" | "none" | "seed-label" | "skipped-label" | "unauthorized";
  name: string | null;
};

/**
 * The numeric tier for each rung — the stored `tracks.capture_priority`, high = capture sooner.
 *
 * THE VETO GETS ITS OWN TIER (−1), and that is load-bearing rather than cosmetic. It first
 * shipped collapsed into `none`'s 0, which made it invisible to SQL: the capture WORK QUEUE
 * (track-work.ts) could not tell "nothing ties this to the archive, so capture it last" from
 * "the operator ruled this label out, so never spend a metered per-GB byte on it". A veto that
 * only sorts last is not a veto — the queue drains, and last eventually arrives.
 *
 * With its own tier the queue enforces it as a predicate (`capture_priority >= 0`), while every
 * DISPLAY property the-ear.md promises survives untouched: the row keeps its place in the
 * capture lens (`capture_priority is not null`), still sorts last under `order by … desc`, and
 * still carries its honest reason line. Ordered last, kept anyway — and never bought.
 *
 * ── THE NEGATIVE BAND, AND WHY `unauthorized` IS −3 (RFC artist-primary-capture, slice 1) ──
 * Three distinct negatives now share the "never bought, but kept and shown, ranked last"
 * contract, and their ORDER on the board (a DESC read) is by how SPECIFIC the reason is:
 *   −1 `skipped-label` — the operator's explicit ruling ("not your lane"). The hardest NO.
 *   −2 `duplicate`     — an identity fact ("already in the archive"); set outside this map,
 *                        in the sweep (see `DUPLICATE_CAPTURE_TIER`).
 *   −3 `unauthorized`  — the softest: no qualified artist yet, and the label is not `enabled`.
 *                        It reads dead last because it is the DEFAULT withholding, not a
 *                        judgement — and it is the one most likely to FLIP to authorized as the
 *                        `track_artists` graph drains (slice 0) or the operator enables a label.
 * All three are excluded from the capture queue by the single `capture_priority >= 0` predicate
 * (track-work.ts) — no new mechanism, one more value riding a rail that already exists.
 */
const CAPTURE_TIER: Record<CapturePriorityReason["kind"], number> = {
  artist: 3,
  label: 2,
  none: 0,
  "seed-label": 1,
  "skipped-label": -1,
  unauthorized: -3,
};

/**
 * The capture tier for a DUPLICATE — a catalogue row whose ISRC exactly matches a certified
 * finding's, i.e. the SAME RECORDING Fluncle already owns (docs/the-ear.md § Duplicates).
 *
 * It is −2, STRICTLY below the label veto (−1), for two reasons. First, "we already own this"
 * is a stronger, more permanent statement than "not your lane" — it is an identity fact, not a
 * taste ruling — so it reads dead last on the capture board. Second, and load-bearing: the
 * capture WORK QUEUE excludes any negative tier with its existing `capture_priority >= 0`
 * predicate (track-work.ts), so a duplicate is never bought and no new predicate is needed — the
 * money saver is a reused veto, not a second mechanism. `duplicate_of_track_id` carries WHICH
 * finding it duplicates, so the board can name it rather than let it silently vanish.
 *
 * This is NOT a `capturePriorityFor` rung: that function is a PURE metadata ladder over
 * artists+label, and a duplicate is an IDENTITY match that needs the ISRC and the finding
 * corpus — so it is detected in the sweep and STORED (like `nearest_finding_track_id`), never
 * re-derived. A duplicate row's metadata rung stays truthful; the marker overrides its display.
 */
export const DUPLICATE_CAPTURE_TIER = -2;

/**
 * The cosine-similarity threshold at or above which a SCORED catalogue row is displayed as a
 * duplicate ("already in the archive") rather than a discovery (docs/the-ear.md § Duplicates).
 *
 * The two halves of duplicate detection fire at different points in a track's life. The ISRC
 * match (above) is the pre-audio money saver — it stops a duplicate being CAPTURED. This is the
 * post-embed honesty marker: once a row HAS a vector, an identical master scores ~1.0 against
 * the finding it duplicates (the real event that motivated this: a crawled "Infinity" scored a
 * perfect 1.0 against a logged track), so a near-1.0 score is the tell that the Ear is pointing
 * at something Fluncle already has, not a find.
 *
 * 0.995 is chosen defensibly for MuQ vectors: the same master scores ~1.0 (float32 rounding
 * keeps an identical vector comfortably above 0.995), while a remaster, a radio edit, or a
 * VIP — a genuinely different recording — arranges differently enough to land below it, and a
 * merely SIMILAR track (a different roller in the same pocket) lands far lower still. It is
 * DISPLAY-ONLY (no state machine, nothing stored) and tunable: raise it toward 1.0 to flag only
 * bit-identical masters, lower it to also catch alternate masters of the same performance.
 */
export const DUPLICATE_SIMILARITY = 0.995;

/**
 * The LONG-FORM veto (operator ruling, 2026-07-13): a "track" at or above this duration is not a
 * track — it is a continuous DJ mix riding a MusicBrainz compilation release ("Drum&BassArena
 * Summer Selection 2012 (Continuous mix 1)", 78 minutes; "Ten Years of Med School (continuous
 * mix)", 60 minutes). The crawler mints them honestly (they ARE recordings on releases it walks),
 * but they are unloggable as findings and poisonous to the ear lens: an hour-long mean-pooled MuQ
 * vector is a taste-centroid of everything inside it, so a mix ranks artificially high against
 * ANY finding (the two above scored 0.92/0.91) while never being a discovery. They are also the
 * fattest thing the metered capture can buy (74.5 MB for one mix — the audit's max-file outlier).
 *
 * So a long-form row is excluded from BOTH lenses and the CAPTURE QUEUE (81 uncaptured mixes ≈
 * 4–5 GB of proxy spend this veto refuses), by duration alone — deterministic, no title
 * heuristics. 15 minutes is comfortably above any real DnB single (the longest liquid rollers run
 * ~12) and comfortably below any mix. The rows KEEP their data (a captured mix keeps its bytes and
 * vector — already paid for, and harmless to others: a catalogue row is never anyone's
 * nearest-finding candidate); the veto is a READ + QUEUE exclusion, never a deletion.
 */
export const LONG_FORM_MS = 15 * 60_000;

/**
 * The long-form veto's LOWER twin (the 2026-07-14 unmatched audit). Two classes below this
 * line, both guaranteed-unmatched spend: a sub-60s interlude/skit (a YouTube upload of it
 * rarely exists at that length, and it is worthless to The Ear anyway), and the
 * missing/zero-duration row — with no reference length the sweep's symmetric duration guard
 * can NEVER accept a candidate (`durationWithinTolerance` returns false on a missing
 * target), so every attempt is a billed search that lands `unmatched` by construction (33
 * such rows had, before this bound). SQL note: `duration_ms >= MIN_TRACK_MS` also excludes
 * NULL (NULL comparisons are falsy), so the missing-duration class needs no separate
 * clause; those rows wait for the crawler's metadata backfill instead.
 */
export const MIN_TRACK_MS = 60_000;

/**
 * The cosine-similarity threshold at or above which a SCORED catalogue row is adjudicated rather
 * than merely labelled — a DISTINCT, higher line than `DUPLICATE_SIMILARITY` (docs/the-ear.md
 * § Wrong audio). The difference is the whole point:
 *
 *   - `DUPLICATE_SIMILARITY` (0.995) — the SAME-TITLE display band [0.995, 0.9995). A remaster,
 *     a radio edit, an alternate master: a genuinely close-but-different recording of a track
 *     Fluncle already logged. It is honestly LABELLED "already in the archive" and left alone —
 *     the audio is real and it is correctly this row's audio.
 *   - `WRONG_AUDIO_QUARANTINE` (0.9995) — the CROSS-TITLE cliff. MuQ cosine at six-plus nines is
 *     not "similar songs", it is the SAME MASTER. So a row scoring here against a finding with a
 *     DIFFERENT title is almost certainly WRONG AUDIO: the capture sweep matched the artist's
 *     already-logged hit instead of the track the row names (the Flowidus "Find Your Love"
 *     carrying "Shelter"'s audio, caught in the 2026-07-12 capture audit). That row is vetoed,
 *     quarantined, and re-captured — never allowed to float to the top of the ear lens as a fake
 *     perfect find. A same-title near-1.0 is instead a TRUE duplicate (the crawler re-found a
 *     logged track, correct audio and all) and routes to the pre-audio duplicate handling.
 *
 * The discriminator is a folded title+artist `matchKey` (track-match.ts) between the row and the
 * finding it scored against: EQUAL ⇒ true duplicate, DIFFERENT ⇒ wrong audio. Both live above
 * `DUPLICATE_SIMILARITY`, so the display band below is untouched.
 */
export const WRONG_AUDIO_QUARANTINE = 0.9995;

/**
 * THE DIVERSITY DECAY (operator ruling, 2026-07-15): the ear's raw ranking is max-similarity,
 * which is structurally a sonic-clone magnet — an artist Fluncle has logged boosts ALL their
 * other tracks, and a page of eleven A-minor rollers from 2019 is a worse telescope than a
 * spread. So the ranked PAGE is re-ordered greedily: each candidate's raw score is decayed by
 * how many rows of the same artist / release year / musical key already sit above it
 * (raw × ARTIST^a × YEAR^y × KEY^k). Read-time only — the STORED score stays pure similarity
 * (the WHY the row displays), labels deliberately carry no decay (the operator's call), and a
 * missing year/key simply contributes no factor. Artist decays hardest (the clone magnet),
 * year gentler, key gentlest (a mixtape-building nicety, not a taste statement).
 */
export const EAR_DIVERSITY_DECAY = { artist: 0.97, key: 0.99, year: 0.985 } as const;

/**
 * The `capture_status` a quarantined row carries — a wrong-audio capture awaiting re-download
 * (docs/the-ear.md § Wrong audio). It is a re-capture TRIGGER in the capture work queue
 * (track-work.ts) and a GUARD the embed/analyze queues honour (they must not re-embed the bad
 * bytes still on file). Not a `TrackUpdate.captureStatus` the sweep writes — the `rank_catalogue`
 * sweep stamps it directly, the same way it writes the other derived ranking columns.
 */
export const WRONG_AUDIO_STATUS = "wrong-audio";

/**
 * The `capture_status` the OPERATOR force-clear stamps (`clearWrongAudio`) — "I disagree, this
 * capture is fine, stop re-capturing it". It is a STICKY override: the `rank_catalogue` sweep
 * never re-quarantines a `quarantine-cleared` row even when it scores back into the wrong-audio
 * band, so the operator's ruling wins exactly like an operator note wins over the auto-note. The
 * embed queue re-embeds its kept audio, and the row then ranks normally (reading as a duplicate
 * if it genuinely matches, or a discovery if it does not).
 */
export const QUARANTINE_CLEARED = "quarantine-cleared";

/**
 * The `capture_status` the OPERATOR force-capture stamps (`forceCapture`) — the dupe-veto escape
 * hatch (docs/the-ear.md § Duplicates). "This row is NOT the duplicate the sweep thinks it is —
 * capture it / rank it on its own merits." It is the `QUARANTINE_CLEARED` sibling for the OTHER
 * self-sealing verdict: a duplicate veto (`duplicate_of_track_id` + the −2 tier) can be WRONG (a
 * shared or mis-assigned ISRC, a `matchKey` collision on a genuinely different recording), and
 * without an override the row can never be captured, so the post-audio check that would exonerate
 * it never runs. This is that override, and it is STICKY: all FOUR duplicate detectors respect it
 * before re-stamping —
 *
 *   1. the pre-audio ISRC match to a finding (`preAudioPriority`),
 *   2. the pre-audio + scored matchKey match to a finding — a logged track's folded title+artist
 *      twin, the 2026-07-15 "Drifting Away" ruling (`preAudioPriority` / the scored path),
 *   3. the near-1.0 post-embed same-title adjudication (the scored path),
 *   4. the catalogue↔catalogue dedup (`catalogueDuplicateOf` + `readCatalogueIdentity`),
 *
 * so the sweep's self-healing re-rank (which re-stamps a duplicate on every tick as the corpus
 * fingerprint moves) never re-marks a force-captured row. A cleared row is also excluded from
 * being a CANONICAL sibling (`readCatalogueIdentity`), so the operator's ruling takes it out of
 * the duplicate equivalence class in both directions.
 *
 * IT BYPASSES THE DUPLICATE VETO, NEVER THE VERIFICATION GATE. The escape hatch only lifts the
 * duplicate marker; a re-captured forced row still runs the #578 fingerprint gate at ingest, and
 * a DIFFERENT-title near-1.0 (wrong audio) still quarantines. Getting the row captured is exactly
 * what lets the finding-side detectors (1, 2) settle it honestly: once it has its OWN vector, a
 * genuinely different recording no longer scores identical, so the exoneration the RFC describes
 * finally runs. The capture work queue (track-work.ts) treats an UNCAPTURED `duplicate-cleared`
 * row as capture-eligible for precisely this reason.
 *
 * AND THE SENTINEL SURVIVES THE CAPTURE IT ENABLES. The forced row is EXPECTED to be captured, and
 * the capture sweep's terminal PATCH (`captureStatus: 'done'` — or `failed`/`unmatched`) would
 * overwrite the sentinel at exactly the moment it must hold: the post-embed re-rank would then
 * re-mark the row a duplicate, silently reversing the ruling right after the capture the operator
 * paid for. So the generic update path carries a RULING GUARD (track-update.ts): a machine PATCH
 * never overwrites `duplicate-cleared` — the same class of guarantee as the auto-note's
 * fill-empty-only rule (an operator ruling is never clobbered by a machine write). The scheduling
 * state the queue reads (`source_audio_key`, the attempt stamps, the failure count) still lands
 * normally, and the queue's `duplicate-cleared` arm keys off THOSE columns (a captured row stays
 * out; a failed retry backs off) since the status itself no longer moves. The ONE writer that may
 * overwrite the sentinel is the rank sweep's wrong-audio quarantine (direct SQL) — the
 * verification gate deliberately outranks the duplicate override.
 */
export const DUPLICATE_CLEARED = "duplicate-cleared";

// ── The bad-audio memory, server side (docs/the-ear.md § Wrong audio) ──────────────────
// The GENERAL form of the single-sha memory that once lived embedded in a kept `source_audio_key`.
// A JSON array on `tracks.source_audio_rejected` ({ videoId?, sha256, reason, at }, capped). Every
// server write-path that REWINDS a row (the rank quarantine, `flagWrongAudio`, `verifyCapture`)
// grows it the same way, so the capture sweep's pre-download videoId filter + sha backstop always
// read a consistent memory. It MIRRORS the box's fingerprint-match.ts helper (the box cannot import
// the workspace) — keep the two in step.

/** One remembered bad-audio source. `videoId` is the pre-download filter; `sha256` the backstop. */
type RejectedSource = { at: string; reason: string; sha256: string; videoId?: string };

/** The cap on the memory — the newest N, oldest dropped. */
const REJECTED_MEMORY_CAP = 10;

/** The sha256 embedded in a `<root>/<sha256>.<ext>` source-audio key, lowercased, or null. */
function shaFromSourceAudioKey(key: null | string): null | string {
  if (!key) {
    return null;
  }

  const base = key.split("/").pop() ?? "";
  const dot = base.indexOf(".");
  const hash = (dot >= 0 ? base.slice(0, dot) : base).toLowerCase();

  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

function parseRejectedSources(value: null | string): RejectedSource[] {
  if (!value) {
    return [];
  }

  let raw: unknown;

  try {
    raw = JSON.parse(value);
  } catch {
    return [];
  }

  if (!Array.isArray(raw)) {
    return [];
  }

  const out: RejectedSource[] = [];

  for (const entry of raw) {
    const row = entry as Partial<RejectedSource> | null;

    if (row && typeof row.sha256 === "string" && typeof row.at === "string") {
      out.push({
        at: row.at,
        reason: typeof row.reason === "string" ? row.reason : "rejected",
        sha256: row.sha256,
        ...(typeof row.videoId === "string" ? { videoId: row.videoId } : {}),
      });
    }
  }

  return out;
}

/**
 * Append a rejected sha256 (derived from the poisoned capture's key) to the memory JSON, capped +
 * deduped. Returns the next JSON string, or the existing value unchanged when there is no sha to
 * remember (a legacy row with no key-embedded digest) — the rewind still proceeds, it just has
 * nothing new to store. `now` is injected so the write is deterministic in tests.
 */
function appendRejectedSha(
  existing: null | string,
  sha: null | string,
  reason: string,
  now: string,
): null | string {
  if (!sha) {
    return existing;
  }

  const prior = parseRejectedSources(existing).filter((row) => row.sha256 !== sha);
  const next: RejectedSource[] = [...prior, { at: now, reason, sha256: sha }].slice(
    -REJECTED_MEMORY_CAP,
  );

  return JSON.stringify(next);
}

/**
 * The archive's cheap identity sets — bounded by the FINDING count (and the in-lane `enabled`
 * subset), never by the raw catalogue that grows.
 */
export type ArchiveAffinity = {
  /** Label slugs the operator ruled OUT (`labels.seed_state = 'disabled'`) — "not our lane". */
  disabledLabels: Set<string>;
  /** Lowercased names of every artist on a finding — the tier-3 ORDERING hint (never authorization). */
  findingArtists: Set<string>;
  /** Label slugs that already carry a finding — the tier-2 ORDERING hint (never authorization). */
  findingLabels: Set<string>;
  /**
   * The QUALIFIED artist ids — the AUTHORIZATION set (RFC artist-primary-capture, slice 1). An
   * `artists.id` is qualified iff it has ≥1 certified finding (via `track_artists` → `findings`)
   * OR its weighted release count on `enabled` labels is ≥ 3 (primary credit 1.0, `remixer` 0.5).
   * Matched by IDENTITY through the `track_artists` graph, never by name-fold: a name string is
   * not enough identity to spend on. Bounded by the finding count + the enabled-label release set.
   */
  qualifiedArtists: Set<string>;
  /** Label slugs the operator rules the crawler may seed from (`labels.seed_state = 'enabled'`). */
  seedLabels: Set<string>;
};

/**
 * A catalogue track's identity, in the shape the capture ladder needs. `artistIds` are the
 * graph edges (`track_artists.artist_id`) that drive AUTHORIZATION; `artists` are the raw names
 * that drive the tier-3 ORDERING hint and are spoken back on the row. An edge-less row (no slice-0
 * fold yet) carries an empty `artistIds` and can only authorize via its `enabled` label.
 */
export type CaptureCandidate = { artistIds: string[]; artists: string[]; label: string | null };

/**
 * Where a not-yet-captured catalogue track sits in the capture queue, and why.
 *
 * ── TWO QUESTIONS, CLEANLY SEPARATED (RFC artist-primary-capture, slice 1) ──────────────
 * AUTHORIZATION decides whether we may spend a metered per-GB byte on this row at all; PRIORITY
 * decides, among the rows we may buy, who first. Capture is artist-driven, discovery is
 * label-driven — an artist who moved from a scene label to a major arrives by themselves, and
 * his other tunes deserve the spend even though the major is not a seed.
 *
 *   ✗ · `skipped-label` — THE VETO, checked FIRST. Its label is one the operator ruled OUT
 *                      ("not our lane"). Tier −1, no matter what else is true of the track.
 *   ✗ · `unauthorized`  — no credited artist is QUALIFIED and the label is not `enabled`.
 *                      Metadata welcome, money withheld. Tier −3 (excluded by the same
 *                      `capture_priority >= 0` queue predicate as the veto).
 *
 * Among AUTHORIZED rows the old explainable ladder survives as the ORDERING hint:
 *   3 · `artist`     — a credited artist is qualified (identity), OR an artist name is already
 *                      on a finding. The strongest signal: his ear has said yes to this artist.
 *   2 · `label`      — its label already carries a finding. A crate he digs in — but only a
 *                      HINT now: a finding lifts its ARTIST, never its label's neighbours, so
 *                      this rung is reachable ONLY once the row is already authorized.
 *   1 · `seed-label` — its label is `enabled`, nothing certified on it yet. In-lane, unproven.
 *   0 · `none`       — authorized with no ordering hint (unreachable in practice: authorization
 *                      is a qualified artist [→3] or an enabled label [→≥1]). Kept for legacy rows.
 *
 * ── WHY AUTHORIZATION IS BY IDENTITY, AND WHAT CHANGED ──────────────────────────────────
 * `findingLabels` was the tier-2 AUTHORIZER; it is now a hint only. The counter-example is
 * live: a single Atlantic-UK finding used to lift EVERY crawled Atlantic-UK track to tier 2 and
 * into the capture budget. A finding is evidence about an ARTIST, not a licence to buy a label's
 * whole catalogue — so `findingLabels` no longer opens the gate, and an un-`enabled` label with
 * a lone crossover finding no longer authorizes its label-mates. Matching is by `artists.id`
 * through the `track_artists` graph, never a name-fold: a name string is not enough identity to
 * spend money on (an edge-less row can only authorize via its `enabled` label).
 *
 * ── WHY THE VETO IS NOT OPTIONAL, AND WHY IT IS NOT A CRAWL-SCOPE VIOLATION ─────────────
 * Every one of the operator's 8 DISABLED labels — Anjunabeats, Armada, Axtone, Positiva … —
 * CARRIES A FINDING: each arrived on a single crossover remix. The veto sinks them before any
 * other signal, and it does NOT breach the crawl-scope-never-storage rule (docs/label-entity.md):
 * a ruling governs what Fluncle ACQUIRES next, and a capture IS an acquisition. Nothing stored
 * moves — the track keeps its row, keeps appearing in the capture lens, and keeps its honest
 * reason line. It is ordered last, not deleted, hidden, or changed. The same is true of an
 * `unauthorized` row: withheld, never removed.
 *
 * PURE, so the ladder has exactly one authority: the sweep calls it to WRITE the tier, and
 * the surface calls it to EXPLAIN the tier. They cannot drift, because they are the same
 * function. Label matching goes through `labelSlug` — the same fold that makes `Pilot.` and
 * `Pilot` one label everywhere else in the archive.
 */
export function capturePriorityFor(
  candidate: CaptureCandidate,
  archive: ArchiveAffinity,
): { priority: number; reason: CapturePriorityReason } {
  const slug = labelSlug(candidate.label);

  // The veto, before anything else: a ruled-out label sinks the track whatever its artist.
  if (slug && candidate.label && archive.disabledLabels.has(slug)) {
    return {
      priority: CAPTURE_TIER["skipped-label"],
      reason: { kind: "skipped-label", name: candidate.label },
    };
  }

  // AUTHORIZATION: a credited artist is qualified (identity, through the graph) OR the label is
  // `enabled`. Nothing else opens the gate — not a name match, not a finding on the label.
  const enabledLabel = Boolean(slug && candidate.label && archive.seedLabels.has(slug));
  const qualifiedArtist = candidate.artistIds.some((id) => archive.qualifiedArtists.has(id));

  if (!qualifiedArtist && !enabledLabel) {
    return { priority: CAPTURE_TIER.unauthorized, reason: { kind: "unauthorized", name: null } };
  }

  // PRIORITY (authorized rows only): the old explainable ladder, now a pure ordering hint.
  // Tier 3 fires on the qualified identity OR the name-fold finding-artist hint — both are
  // valid ordering signals, and both are only reachable here, past the authorization gate.
  const nameOnFinding = candidate.artists.find((artist) =>
    archive.findingArtists.has(artist.trim().toLowerCase()),
  );

  if (qualifiedArtist || nameOnFinding !== undefined) {
    // Speak the name back: prefer a spelling that is actually on a finding, else the row's first
    // credit (the qualified-by-weighted-count case), else null (an enabled-label-only qualifier).
    const named = nameOnFinding ?? candidate.artists[0] ?? null;

    return { priority: CAPTURE_TIER.artist, reason: { kind: "artist", name: named } };
  }

  if (slug && candidate.label) {
    // Tier 2 is a HINT now, reachable only because the row is already authorized (its label is
    // `enabled`). A finding on the label no longer authorizes its neighbours (the Atlantic-UK
    // counter-example), so this can only fire on an enabled label that also carries a finding.
    if (archive.findingLabels.has(slug)) {
      return { priority: CAPTURE_TIER.label, reason: { kind: "label", name: candidate.label } };
    }

    if (archive.seedLabels.has(slug)) {
      return {
        priority: CAPTURE_TIER["seed-label"],
        reason: { kind: "seed-label", name: candidate.label },
      };
    }
  }

  return { priority: CAPTURE_TIER.none, reason: { kind: "none", name: null } };
}

/**
 * The capture ladder for a STORED row — `capturePriorityFor` plus the OPERATOR-AUTHORIZATION
 * override (RFC artist-primary-capture, slice 1). A force-captured row (`DUPLICATE_CLEARED`,
 * docs/the-ear.md § Duplicates) is an explicit operator decision to SPEND: he overruled the
 * duplicate veto to get this exact row bought. That same act lifts the artist-driven authorization
 * gate — so an otherwise-`unauthorized` cleared row is floored to `none` (tier 0), which keeps it
 * capture-eligible (the escape hatch's whole point) and its staleness re-pick alive once the fresh
 * vector lands (`capture_priority >= 0`). The DISABLED-label veto is still checked first inside
 * `capturePriorityFor` and is NEVER floored: overruling a duplicate verdict is not overruling a
 * label ruling. Both the sweep (the write authority) and the surface (the explanation) call THIS,
 * so the tier and its reason still cannot drift.
 */
function ladderTierForRow(
  candidate: CaptureCandidate,
  archive: ArchiveAffinity,
  operatorAuthorized: boolean,
): { priority: number; reason: CapturePriorityReason } {
  const base = capturePriorityFor(candidate, archive);

  if (operatorAuthorized && base.reason.kind === "unauthorized") {
    return { priority: CAPTURE_TIER.none, reason: { kind: "none", name: null } };
  }

  return base;
}

// ── The staleness fingerprint ────────────────────────────────────────────────────────

/**
 * The fingerprint of the finding corpus a ranking was computed against —
 * `"<findings>:<embedded findings>"`, stored on every ranked row as `catalogue_rank_corpus`.
 *
 * THIS IS WHAT MAKES THE SWEEP SELF-HEALING — but it is only HALF the staleness model.
 * Both numbers move whenever the CORPUS side of the answer could change: log a finding and
 * the first moves (a new artist/label affinity, a new nearest candidate); embed one and the
 * second moves (a new vector to be near). A row whose stored fingerprint differs from the
 * live one is stale and re-ranks on a later tick — so the sweep converges on its own after
 * ANY archive change, and needs no invalidation call from the publish path.
 *
 * The other half is the ROW side: a catalogue track that gains its OWN vector (captured →
 * embedded) moves neither number, so the fingerprint alone would leave it ranked forever on
 * the pre-audio ladder — 58 freshly-embedded tracks sat invisible to The Ear the first time
 * this happened. The discriminator is `capture_priority`: the vectored scoring path nulls it for
 * an ordinary find, and only the pre-audio ladder sets a NON-NEGATIVE tier. So
 * `has_vector AND capture_priority IS NOT NULL AND capture_priority >= 0` reads precisely as
 * "ranked before its vector arrived" and joins the stale predicate — one tick re-scores it, the
 * write nulls the tier, and it leaves the set (no loop, even for a malformed vector).
 *
 * The `>= 0` clause carves out the one case where the scoring path DELIBERATELY leaves a negative
 * tier on a vectored row: a −2 TRUE DUPLICATE (docs/the-ear.md § Wrong audio). That is a decision,
 * not a pre-audio leftover, so it must NOT read as stale — and it never arises organically (a
 * negative pre-audio tier is excluded from capture, so it never gains a vector on its own).
 *
 * The fingerprint is compared with `<>`, never `<`, so a DELETED finding (the count goes
 * down) is caught exactly like an added one.
 *
 * ── THE GRAPH SIGNALS (RFC artist-primary-capture, slice 1) ────────────────────────────
 * Authorization now depends on inputs the two finding counts do NOT move: the `track_artists`
 * graph (a qualified artist is an identity edge), and the `enabled`/`disabled` label rulings. So
 * three more signals fold in, and each is load-bearing: a ranking computed before the graph
 * carried a row's edges — or before a label was enabled — would authorize it wrongly and stay
 * that way, because nothing would re-stale it. `trackArtists` is the total edge count (it MOVES
 * as slice 0's backfill drains, so every catalogue row re-ranks against the growing graph and the
 * new gate reaches old rows); `enabledLabels` / `disabledLabels` are the ruling counts (they move
 * on a seed-state change). The qualified SET is a function of exactly these plus the findings, so
 * folding the raw inputs is both sufficient and cheaper than recomputing the set in the count phase.
 *
 * A leading RANKING-LOGIC VERSION is folded in so a change to the sweep's ALGORITHM (not just
 * the corpus) invalidates every stored fingerprint and forces one self-healing full re-rank —
 * the same mechanism, no bulk write, no manual invalidation. Bump it only when the ranking
 * DECISION changes for rows the corpus counts did not move: `v2` added catalogue-internal
 * duplicate detection (docs/the-ear.md § Duplicates), which must re-mark rows already ranked;
 * `v3` added the matchKey-vs-findings detector (the 2026-07-15 "Drifting Away" ruling), which
 * must re-mark an ALREADY-RANKED scored row that earlier ticks left as a discovery — a 0.94 twin
 * of a logged finding whose corpus counts never moved would otherwise keep its stale ear slot;
 * `v4` moved capture authorization from labels to the artist graph (RFC artist-primary-capture,
 * slice 1), so every already-ranked pre-audio row must re-derive its tier under the new gate.
 */
const RANK_LOGIC_VERSION = "v4";

export function rankCorpus(
  findings: number,
  embeddedFindings: number,
  trackArtists: number,
  enabledLabels: number,
  disabledLabels: number,
): string {
  return `${RANK_LOGIC_VERSION}:${findings}:${embeddedFindings}:${trackArtists}:${enabledLabels}:${disabledLabels}`;
}

// ── The sweep ────────────────────────────────────────────────────────────────────────

/** One tick's outcome — the JSON summary line a `--no-agent` cron prints. */
export type RankCatalogueSummary = {
  /**
   * Catalogue rows re-pointed at a CANONICAL catalogue sibling this tick — the same master the
   * crawler re-found under a second MusicBrainz MBID (docs/the-ear.md § Duplicates). Marked
   * `duplicate_of_track_id` + the −2 tier, so it leaves both the capture queue and the ear lens.
   */
  catalogueDuplicates: number;
  /** The live finding-corpus fingerprint this tick ranked against. */
  corpus: string;
  /** Embedded findings — how many vectors a candidate could be near. */
  embeddedFindings: number;
  /** Total findings — the affinity corpus behind the capture ladder. */
  findings: number;
  /** Catalogue rows given a `capture_priority` (they have no audio yet). */
  prioritized: number;
  /**
   * Catalogue rows QUARANTINED this tick — a scored row whose near-1.0 cross-title match to a
   * finding means the capture landed the WRONG audio (docs/the-ear.md § Wrong audio). It is
   * vetoed from the ear lens, re-queued for capture, and never counted as a `scored` find.
   */
  quarantined: number;
  /**
   * The drain signal — "> 0 means run me again". By DEFAULT it is INFERRED from batch fullness, not
   * scanned (the ~19s anti-join COUNT is off the hot path, docs/db-scale-backlog Wave 1 #1): a FULL
   * batch (`candidates.length >= limit`) means more rows are stale by construction, so it returns the
   * `>0` sentinel; a SHORT batch means the stale set was fully consumed this tick, so it returns 0.
   * Pass `countRemaining` for the real live COUNT instead — the human-facing CLI readout does, so a
   * deliberate manual run still shows the true backlog, while the box sweep keeps the fast sentinel.
   * The COUNT also survives the `limit <= 0` guard, where no batch was observed and an assumed 0
   * would wrongly stop a cron mid-backlog.
   */
  remaining: number;
  /** Catalogue rows given a `nearest_finding_score` (they have a vector). */
  scored: number;
};

/** The default candidates per tick. `batch × findings` bounds the tick's cosine work. */
export const RANK_BATCH_SIZE = 250;

/**
 * The `remaining` "run me again" sentinel returned on a FULL batch (docs/db-scale-backlog Wave 1 #1).
 * A full batch consumed exactly `limit` stale rows, so more are stale by construction — but counting
 * how many is the ~19s anti-join scan this hoist removes. The sweep only reads `remaining` for its
 * `=== 0` stop test (rank-sweep.ts), so any positive value carries the whole signal; it is NOT a count.
 */
const RANK_MORE_REMAIN = 1;

type CandidateRow = {
  artists_json: string;
  capture_status: string | null;
  has_vector: number;
  isrc: string | null;
  label: string | null;
  // Read only so a wrong-audio QUARANTINE can grow the bad-audio memory (source_audio_rejected)
  // with the poisoned capture's sha256, derived from its key (docs/the-ear.md § Wrong audio).
  source_audio_key: string | null;
  source_audio_rejected: string | null;
  title: string;
  track_id: string;
};

type WinnerRow = { cid: string; dist: number; fid: string };

/**
 * The pre-audio capture tier a row would sit at if it had no vector — the ISRC-duplicate check,
 * then the metadata ladder. Shared by the unvectored branch (its normal job) and the wrong-audio
 * QUARANTINE (which rewinds a vectored row to pre-audio and needs to know where it lands: back on
 * the capture ladder, or vetoed off it). Pure over the two finding-bounded corpora.
 */
function preAudioPriority(
  candidate: {
    artists_json: string;
    capture_status?: null | string;
    isrc: null | string;
    label: null | string;
    title: string;
  },
  archive: ArchiveAffinity,
  findingIsrcs: Map<string, string>,
  findingMatchKeys: Map<string, string>,
  // The row's graph edges (`track_artists.artist_id`), for the artist-driven authorization gate
  // (RFC artist-primary-capture, slice 1). Empty for an edge-less row — it can only authorize via
  // its `enabled` label. Passed alongside the candidate rather than parsed from it because the
  // edges live in `track_artists`, not on the `tracks` row.
  artistIds: string[],
): { duplicateOf: null | string; priority: number } {
  // The operator's force-capture (`DUPLICATE_CLEARED`) overrules the duplicate veto stickily
  // (docs/the-ear.md § Duplicates): skip BOTH duplicate probes so the row lands on its HONEST
  // ladder tier and re-enters the capture queue, instead of being re-vetoed to −2 every tick.
  const cleared = candidate.capture_status === DUPLICATE_CLEARED;
  const isrcKey = cleared ? null : normalizeIsrc(candidate.isrc);
  const isrcDup = isrcKey ? (findingIsrcs.get(isrcKey) ?? null) : null;
  // After the ISRC miss, the FOLDED TITLE+ARTIST identity (the 2026-07-15 "Drifting Away" ruling):
  // a crawled row whose `matchKey` equals a certified finding's is the same song — a duplicate
  // regardless of ISRC (a YouTube rip carries none) and regardless of any later embedding score.
  const keyDup =
    cleared || isrcDup
      ? null
      : (findingMatchKeys.get(
          matchKey(parseArtistsJson(candidate.artists_json), candidate.title),
        ) ?? null);
  const duplicateOf = isrcDup ?? keyDup;
  const priority = duplicateOf
    ? DUPLICATE_CAPTURE_TIER
    : ladderTierForRow(
        { artistIds, artists: parseArtistsJson(candidate.artists_json), label: candidate.label },
        archive,
        // A cleared row's duplicate probes were already skipped above; the same operator ruling
        // authorizes its spend, so an unauthorized cleared row is floored to a capture-eligible tier.
        cleared,
      ).priority;

  return { duplicateOf, priority };
}

/**
 * The graph edges for a BATCH of candidate tracks — `track_id` → its `track_artists.artist_id`
 * list, for the artist-driven authorization gate (RFC artist-primary-capture, slice 1).
 *
 * ONE batched `in (…)` read, bounded by the batch and riding `track_artists_track_id_idx` — never
 * a per-row subquery over the growing table (the tracks-hub late-row-lookup lesson at sweep scale).
 * A track absent from the map (or here, an edge-less row) has no edges yet: `capturePriorityFor`
 * reads that as an empty `artistIds`, so it can authorize only via an `enabled` label until slice 0
 * folds its names onto real `artists` rows.
 */
async function readTrackArtistIds(trackIds: string[]): Promise<Map<string, string[]>> {
  const byTrack = new Map<string, string[]>();

  if (trackIds.length === 0) {
    return byTrack;
  }

  const db = await getDb();
  const result = await db.execute({
    args: trackIds,
    sql: `select track_id, artist_id
          from track_artists
          where track_id in (${trackIds.map(() => "?").join(", ")})`,
  });

  for (const row of typedRows<{ artist_id: string; track_id: string }>(result.rows)) {
    const list = byTrack.get(row.track_id);

    if (list) {
      list.push(row.artist_id);
    } else {
      byTrack.set(row.track_id, [row.artist_id]);
    }
  }

  return byTrack;
}

/**
 * Read the archive's affinity sets. Bounded by the FINDING count (tens of rows today,
 * thousands at worst) and the in-lane `enabled`-label release set — never by the catalogue,
 * which is the table that grows.
 */
async function readArchiveAffinity(): Promise<ArchiveAffinity> {
  const db = await getDb();
  const [artistResult, labelResult, seedResult, findingQualifiedResult, weightedQualifiedResult] =
    await Promise.all([
      db.execute({
        args: [],
        sql: `select tracks.artists_json as artists_json
              from findings join tracks on tracks.track_id = findings.track_id`,
      }),
      db.execute({
        args: [],
        sql: `select distinct tracks.label as label
              from findings join tracks on tracks.track_id = findings.track_id
              where tracks.label is not null and trim(tracks.label) <> ''`,
      }),
      db.execute({
        args: [],
        // The operator's rulings. The ONE sanctioned way `seed_state` reaches this module: it
        // orders what Fluncle ACQUIRES next (a capture is an acquisition), and it never decides
        // what is shown, kept, or removed — see `capturePriorityFor`.
        sql: `select slug, seed_state from labels where seed_state in ('enabled', 'disabled')`,
      }),
      // QUALIFIED (a): an artist id with ≥1 CERTIFIED finding, through the graph. ONE set-building
      // pass, bounded by the finding count (each finding credits a handful of artists) — never the
      // catalogue. Rides `track_artists_track_id_idx` on the findings join.
      db.execute({
        args: [],
        sql: `select distinct ta.artist_id as artist_id
              from track_artists ta
              join findings f on f.track_id = ta.track_id`,
      }),
      // QUALIFIED (b): an artist id whose WEIGHTED release count on `enabled` labels is ≥ 3
      // (primary credit 1.0, remixer 0.5). ONE set-building pass, bounded by the IN-LANE subset:
      // it walks only tracks on enabled labels (via the indexed `tracks.label_id` → `labels.id`
      // join, `tracks_label_id_idx`), never the whole catalogue. `label_id` is the graph-resolved
      // pointer, so an unlinked label STRING that merely folds to an enabled slug does not count —
      // exactly the identity-only discipline the qualified set is built on.
      db.execute({
        args: [],
        sql: `select ta.artist_id as artist_id
              from labels l
              join tracks t on t.label_id = l.id
              join track_artists ta on ta.track_id = t.track_id
              where l.seed_state = 'enabled'
              group by ta.artist_id
              having sum(case when ta.role = 'remixer' then 0.5 else 1.0 end) >= 3`,
      }),
    ]);

  const findingArtists = new Set<string>();

  for (const row of typedRows<{ artists_json: string }>(artistResult.rows)) {
    for (const artist of parseArtistsJson(row.artists_json)) {
      findingArtists.add(artist.trim().toLowerCase());
    }
  }

  const findingLabels = new Set<string>();

  for (const row of typedRows<{ label: string }>(labelResult.rows)) {
    const slug = labelSlug(row.label);

    if (slug) {
      findingLabels.add(slug);
    }
  }

  const disabledLabels = new Set<string>();
  const seedLabels = new Set<string>();

  for (const row of typedRows<{ seed_state: string; slug: string }>(seedResult.rows)) {
    (row.seed_state === "disabled" ? disabledLabels : seedLabels).add(row.slug);
  }

  const qualifiedArtists = new Set<string>();

  for (const row of typedRows<{ artist_id: string }>(findingQualifiedResult.rows)) {
    qualifiedArtists.add(row.artist_id);
  }

  for (const row of typedRows<{ artist_id: string }>(weightedQualifiedResult.rows)) {
    qualifiedArtists.add(row.artist_id);
  }

  return { disabledLabels, findingArtists, findingLabels, qualifiedArtists, seedLabels };
}

/**
 * An ISRC, folded for comparison. ISRCs are case-insensitive alphanumeric codes that carry
 * stray hyphens/spaces in the wild (`GB-AYE-12-34567` vs `GBAYE1234567`), so a raw string
 * equality would miss a real duplicate on a cosmetic difference. Empty/whitespace → null, so a
 * blank ISRC never matches another blank one. Mirrors the spirit of `labelSlug`'s fold.
 */
function normalizeIsrc(isrc: null | string): null | string {
  const folded = (isrc ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();

  return folded.length > 0 ? folded : null;
}

/**
 * The archive's ISRC identity map — normalized ISRC → the certified finding's `track_id`.
 *
 * This is the DUPLICATE detector's corpus (docs/the-ear.md § Duplicates), and it is a WRITE-PATH
 * concern only: the sweep reads it to decide whether a catalogue row is the same recording as a
 * finding, then STORES the answer on `duplicate_of_track_id`. It is deliberately NOT part of
 * `ArchiveAffinity` — that set feeds the PURE metadata ladder (`capturePriorityFor`), which the
 * display re-derives, whereas the duplicate is an identity fact read back from the column, never
 * recomputed at request time (the same store-and-read shape as `nearest_finding_track_id`).
 *
 * Bounded by the FINDING count, like every other affinity read. If two findings somehow share an
 * ISRC, either is a valid "we own this", so last-writer-wins is fine.
 */
async function readFindingIsrcs(): Promise<Map<string, string>> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select findings.track_id as track_id, tracks.isrc as isrc
          from findings join tracks on tracks.track_id = findings.track_id
          where tracks.isrc is not null and trim(tracks.isrc) <> ''`,
  });

  const byIsrc = new Map<string, string>();

  for (const row of typedRows<{ isrc: string; track_id: string }>(result.rows)) {
    const key = normalizeIsrc(row.isrc);

    if (key) {
      byIsrc.set(key, row.track_id);
    }
  }

  return byIsrc;
}

/**
 * The archive's TITLE+ARTIST identity map — finding `track_id` → its folded `matchKey`
 * (track-match.ts). This is the wrong-audio discriminator's corpus (docs/the-ear.md § Wrong
 * audio): when a catalogue row scores ≥ `WRONG_AUDIO_QUARANTINE` against a finding, the sweep
 * compares the row's own `matchKey` to the finding's — EQUAL is a true duplicate (same recording,
 * correct audio), DIFFERENT is wrong audio (the capture grabbed the artist's other, already-logged
 * track). Read only on a tick that actually has a near-1.0 row, so it stays off the common path.
 * Bounded by the FINDING count, like every affinity read.
 */
async function readFindingIdentities(): Promise<Map<string, string>> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select findings.track_id as track_id, tracks.title as title, tracks.artists_json as artists_json
          from findings join tracks on tracks.track_id = findings.track_id`,
  });

  const byTrack = new Map<string, string>();

  for (const row of typedRows<{ artists_json: string; title: string; track_id: string }>(
    result.rows,
  )) {
    byTrack.set(row.track_id, matchKey(parseArtistsJson(row.artists_json), row.title));
  }

  return byTrack;
}

/**
 * The archive's TITLE+ARTIST identity map, INVERTED — folded `matchKey` → the certified finding's
 * `track_id`. The corpus for the matchKey-vs-findings duplicate detector (docs/the-ear.md §
 * Duplicates, the 2026-07-15 "Drifting Away" ruling): a crawled catalogue row whose folded
 * title+artist identity EQUALS a finding's is the same song — a duplicate regardless of ISRC (a
 * YouTube rip of a logged track carries none) and regardless of embedding score (the rip scored a
 * merely-0.94 twin of the finding). It is stamped `duplicate_of_track_id` + tier −2 exactly like the
 * ISRC match, on BOTH sides of the audio boundary (the pre-audio ladder and the scored path).
 *
 * The inverse of `readFindingIdentities` (finding → key, the near-1.0 wrong-audio discriminator):
 * this one is read on EVERY tick with candidates, because a title-duplicate can hide at ANY score,
 * not just in the near-1.0 band. If two findings share an identity the SMALLEST `track_id` wins —
 * the same stable, deterministic canonical precedent `readCatalogueIdentity` uses, so the marker is
 * idempotent across ticks. Bounded by the FINDING count, like every affinity read.
 */
async function readFindingMatchKeys(): Promise<Map<string, string>> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select findings.track_id as track_id, tracks.title as title, tracks.artists_json as artists_json
          from findings join tracks on tracks.track_id = findings.track_id`,
  });

  const byMatchKey = new Map<string, string>();

  for (const row of typedRows<{ artists_json: string; title: string; track_id: string }>(
    result.rows,
  )) {
    const key = matchKey(parseArtistsJson(row.artists_json), row.title);
    const incumbent = byMatchKey.get(key);

    if (incumbent === undefined || row.track_id < incumbent) {
      byMatchKey.set(key, row.track_id);
    }
  }

  return byMatchKey;
}

/**
 * The CATALOGUE-INTERNAL duplicate corpus — the other half of duplicate detection.
 *
 * The finding-bounded maps above catch a catalogue row that duplicates a certified FINDING. They
 * are blind to the commonest duplicate at catalogue scale: the crawler walks MusicBrainz, which
 * carries a distinct recording MBID per release/compilation, so ONE song enters `tracks` as N
 * rows and each is captured + embedded separately — the same master bought two or three times,
 * only one sibling ever carrying an ISRC. This reads the identity of every CAPTURED catalogue row
 * so the sweep can name one canonical sibling and veto the rest off both the capture queue (the
 * money) and the ear lens (the telescope), exactly as the finding duplicate does.
 *
 * The canonical sibling is deterministic: the most-processed one wins (a row that already carries
 * a vector, then the smallest `track_id`), so the choice is stable across ticks and idempotent —
 * the same row stays canonical, its siblings stay marked, no flap.
 *
 * Bounded by the CAPTURED catalogue (the metered ≤1,000/day half), never the raw metadata
 * catalogue that grows unbounded — and it pulls only the tiny identity fields (title, artists,
 * isrc), never a vector. Read once per sweep, only when a batch has candidates to adjudicate.
 */
type CatalogueIdentity = {
  byIsrc: Map<string, string>;
  byMatchKey: Map<string, string>;
};

async function readCatalogueIdentity(): Promise<CatalogueIdentity> {
  const db = await getDb();
  const result = await db.execute({
    args: [WRONG_AUDIO_STATUS, DUPLICATE_CLEARED],
    sql: `select ct.track_id as track_id,
                 ct.title as title,
                 ct.artists_json as artists_json,
                 ct.isrc as isrc,
                 (ct.embedding_blob is not null) as has_vector
          from tracks ct
          where ct.is_catalogue = 1
            and ct.source_audio_key is not null
            and ct.dismissed_at is null
            and (ct.capture_status is null
                 or (ct.capture_status <> ? and ct.capture_status <> ?))
          order by ct.track_id asc`,
  });

  const byMatchKey = new Map<string, string>();
  const byIsrc = new Map<string, string>();
  // Track the winning candidate's vector state per key so a later, more-processed sibling (one
  // that carries a vector) can take the canonical slot from an earlier unembedded one.
  const keyHasVector = new Map<string, boolean>();

  for (const row of typedRows<CatalogueCandidateIdentity>(result.rows)) {
    const key = matchKey(parseArtistsJson(row.artists_json), row.title);
    const hasVector = Number(row.has_vector) === 1;
    const incumbentHasVector = keyHasVector.get(key);

    // First sibling for this identity wins by default; a later one only displaces it when it is
    // MORE processed (carries a vector while the incumbent does not). `track_id asc` ordering
    // makes the "first" deterministic, so canonical selection is stable across ticks.
    if (incumbentHasVector === undefined || (hasVector && !incumbentHasVector)) {
      byMatchKey.set(key, row.track_id);
      keyHasVector.set(key, hasVector);
    }

    const isrcKey = normalizeIsrc(row.isrc);

    if (isrcKey && !byIsrc.has(isrcKey)) {
      byIsrc.set(isrcKey, row.track_id);
    }
  }

  return { byIsrc, byMatchKey };
}

type CatalogueCandidateIdentity = {
  artists_json: string;
  has_vector: number;
  isrc: null | string;
  title: string;
  track_id: string;
};

/**
 * Resolve a candidate to the CANONICAL captured catalogue sibling it duplicates, or null. The
 * folded title+artist `matchKey` is the primary identity (it distinguishes a remix's own
 * descriptor from the base, so it never merges genuinely different recordings); an exact ISRC
 * match is the fallback for a row whose title/artist strings drifted between MBIDs. A row is
 * never its own duplicate — the canonical pointing back at the candidate returns null.
 */
function catalogueDuplicateOf(
  candidate: {
    artists_json: string;
    capture_status?: null | string;
    isrc: null | string;
    title: string;
    track_id: string;
  },
  identity: CatalogueIdentity,
): null | string {
  // The operator's force-capture (`DUPLICATE_CLEARED`) took this row out of its duplicate group
  // (docs/the-ear.md § Duplicates): never re-mark it a sibling, whatever its title/ISRC collides
  // with. `readCatalogueIdentity` also drops it as a canonical CANDIDATE, so the ruling holds both
  // ways — it neither points at a canonical nor becomes one.
  if (candidate.capture_status === DUPLICATE_CLEARED) {
    return null;
  }

  const key = matchKey(parseArtistsJson(candidate.artists_json), candidate.title);
  const byKey = identity.byMatchKey.get(key);

  if (byKey && byKey !== candidate.track_id) {
    return byKey;
  }

  const isrcKey = normalizeIsrc(candidate.isrc);
  const byIsrc = isrcKey ? identity.byIsrc.get(isrcKey) : undefined;

  return byIsrc && byIsrc !== candidate.track_id ? byIsrc : null;
}

/**
 * ONE TICK of the ranking sweep — the whole of The Ear's arithmetic, and the only writer of
 * the five `tracks` ranking columns.
 *
 * The tick, in order:
 *   1. Read the live corpus fingerprint (`rankCorpus`).
 *   2. Take up to `limit` STALE catalogue rows — a row whose stored fingerprint disagrees
 *      with the live one, oldest-id first so the batch is deterministic and the sweep drains
 *      the backlog in a stable order.
 *   3. Split them by whether they carry a vector.
 *      · WITH a vector  → rank IN SQL against every embedded finding; store the nearest
 *        finding's id + the cosine similarity to it. Clear `capture_priority`: this track has
 *        already been captured, so it is not in the capture queue by definition.
 *      · WITHOUT a vector → run the pre-audio ladder (`capturePriorityFor`) and store the
 *        tier. It has no score, and cannot have one until its audio is captured.
 *   4. Stamp the fingerprint + the timestamp on EVERY row in the batch — including a row that
 *      produced no winner (a malformed vector, or an archive with nothing embedded). That
 *      stamp is what stops a hopeless row from being re-picked every tick forever.
 *
 * Idempotent and resume-safe: a crash mid-tick leaves the un-stamped rows stale, so the next
 * tick simply picks them up again. Re-running on a drained catalogue is a no-op.
 *
 * COST. Each tick's cosine work is `candidates-with-a-vector × embedded findings`, all of it
 * inside the database. At the default batch of 250 and 60 findings that is 15,000 distance
 * computations per tick; a full re-rank of a 10k catalogue is 40 ticks and 600k — done once,
 * off the request path, instead of once per page load.
 */
export async function rankCatalogue(
  limit = RANK_BATCH_SIZE,
  countRemaining = false,
): Promise<RankCatalogueSummary> {
  const db = await getDb();
  const countResult = await db.execute({
    args: [],
    // The corpus fingerprint's inputs, in ONE cheap read. The two finding counts are the corpus
    // half; the three below are the graph half authorization now depends on (RFC
    // artist-primary-capture, slice 1) — the total `track_artists` edge count (moves as slice 0's
    // backfill drains, re-staling every catalogue row so the new gate reaches old rows) and the
    // enabled/disabled ruling counts (move on a seed-state change).
    sql: `select
            (select count(*) from findings) as findings,
            (select count(*) from findings join tracks ft on ft.track_id = findings.track_id
             where ft.embedding_blob is not null) as embedded,
            (select count(*) from track_artists) as track_artists,
            (select count(*) from labels where seed_state = 'enabled') as enabled_labels,
            (select count(*) from labels where seed_state = 'disabled') as disabled_labels`,
  });
  const counts = typedRows<{
    disabled_labels: number;
    embedded: number;
    enabled_labels: number;
    findings: number;
    track_artists: number;
  }>(countResult.rows)[0];
  const findings = Number(counts?.findings ?? 0);
  const embeddedFindings = Number(counts?.embedded ?? 0);
  const corpus = rankCorpus(
    findings,
    embeddedFindings,
    Number(counts?.track_artists ?? 0),
    Number(counts?.enabled_labels ?? 0),
    Number(counts?.disabled_labels ?? 0),
  );

  // The stale catalogue rows: fingerprint drift (the corpus moved) OR a vector that arrived
  // after the row was last ranked (it still carries a NON-NEGATIVE pre-audio tier the scoring
  // path always clears — see the rankCorpus doc). The `capture_priority >= 0` clause is what
  // lets the scoring path DELIBERATELY stamp a vectored row with a negative tier (a −2 true
  // duplicate, docs/the-ear.md § Wrong audio) without that stamp reading as "ranked before its
  // vector arrived" — a negative tier is a decision, not a leftover, so it is not re-picked.
  // `has_vector` evaluates the read contract (blob first, guarded JSON fallback) as a BOOLEAN in
  // SQL — no vector ever crosses the wire. A DISMISSED row ("not for me", docs/the-ear.md § The
  // operator's actions) is excluded here so the sweep never spends cosine work re-ranking a row
  // the operator has taken out of the telescope; on restore it re-enters this candidate set and
  // re-ranks if its fingerprint has drifted.
  const candidateResult = await db.execute({
    args: [corpus, Math.max(0, limit)],
    sql: `select ct.track_id as track_id,
                 ct.title as title,
                 ct.artists_json as artists_json,
                 ct.label as label,
                 ct.isrc as isrc,
                 ct.capture_status as capture_status,
                 ct.source_audio_key as source_audio_key,
                 ct.source_audio_rejected as source_audio_rejected,
                 (ct.embedding_blob is not null) as has_vector
          from tracks ct
          where ct.is_catalogue = 1
            and ct.dismissed_at is null
            and (ct.catalogue_rank_corpus is null
                 or ct.catalogue_rank_corpus <> ?
                 or (ct.embedding_blob is not null
                     and ct.capture_priority is not null
                     and ct.capture_priority >= 0))
          order by ct.track_id asc
          limit ?`,
  });
  const candidates = typedRows<CandidateRow>(candidateResult.rows);

  if (candidates.length === 0) {
    // Refresh the cached counts + affinity even on an idle tick: nothing changed this tick, but
    // this is the read `getCatalogueSummary` serves off the hot path, so keeping it warm here means
    // a fresh deploy's very first (empty) rank tick already populates the cache.
    await persistCatalogueCaches();

    // `remaining` on an empty batch: with a POSITIVE `limit` the stale set is genuinely drained (an
    // empty page over `order by track_id asc limit N` means no stale row exists), so the drain
    // signal is 0 with no scan. The real COUNT survives ONLY for the `limit <= 0` guard — there no
    // batch was observed, so an assumed 0 would stop a cron while rows were still stale, and the one
    // cheap scoped COUNT is paid only on that already-idle, can't-have-looked tick.
    return {
      catalogueDuplicates: 0,
      corpus,
      embeddedFindings,
      findings,
      prioritized: 0,
      quarantined: 0,
      remaining: limit <= 0 ? await countStale(corpus) : 0,
      scored: 0,
    };
  }

  const vectored = candidates.filter((row) => Number(row.has_vector) === 1);
  const unvectored = candidates.filter((row) => Number(row.has_vector) !== 1);
  const now = new Date().toISOString();
  const writes: InStatement[] = [];

  // ── The scored half: max-similarity to ANY finding, computed in SQL ────────────────
  // The cross join is `vectored × embedded findings` and nothing else — the batch is what
  // bounds it. `row_number()` picks each candidate's single nearest finding (ties break on
  // the finding's id, so a tick is deterministic). Only `(cid, fid, dist)` comes back.
  //
  // ── WHY BOTH SIDES ARE `MATERIALIZED`, AND WHY THE INNER JOIN IS A `CROSS JOIN` ────
  // This is the CTE-FLATTENING trap (AGENTS.md § Database; docs/local-database.md "Local is
  // not production"), in its cross-join form. A plain CTE is flattened into the enclosing
  // query, so `pair` became a nested loop that RE-EXECUTED the whole `finding_vec` arm once
  // per candidate — and with no `sqlite_stat1` to tell it `findings` is tiny, the planner
  // drove that arm off a full `SCAN` of `tracks`, dragging every 4 KB `embedding_blob` in
  // the catalogue through the loop. Measured in prod (Sentry, 2026-07-18→20): p95 27.0 s,
  // avg 11.3 s per call for 250 candidates × 80 findings — 20k cosines that are microseconds
  // of arithmetic behind hundreds of megabytes of blob I/O. It scaled with the CATALOGUE
  // (the thing the crawler grows), not with the archive it is ranking against.
  //
  // `as materialized` walks each side ONCE into a temp b-tree; the `cross join` pins
  // `findings` (small, and bounded by the archive) as the driver so the finding arm is a
  // scan of `findings` + a primary-key lookup per row instead of a scan of `tracks`. The
  // pair loop then reads two small temp tables. Same rows, same winners — a planner shape,
  // not a semantic change. The `embedding_blob is not null` guards move INTO the CTEs so the
  // materialized sides carry only rows the distance can actually be computed on (they were
  // already required by `pair`'s `where`, so the result set is unchanged).
  const winners = new Map<string, WinnerRow>();

  if (vectored.length > 0 && embeddedFindings > 0) {
    const ids = vectored.map((row) => row.track_id);
    const placeholders = ids.map(() => "?").join(", ");
    const rankedResult = await db.execute({
      args: ids,
      sql: `with finding_vec as materialized (
              select ft.track_id as fid, ft.embedding_blob as fvec
              from findings
              cross join tracks ft on ft.track_id = findings.track_id
              where ft.embedding_blob is not null
            ),
            candidate_vec as materialized (
              select ct.track_id as cid, ct.embedding_blob as cvec
              from tracks ct
              where ct.track_id in (${placeholders})
                and ct.embedding_blob is not null
            ),
            pair as (
              select candidate_vec.cid as cid,
                     finding_vec.fid as fid,
                     vector_distance_cos(candidate_vec.cvec, finding_vec.fvec) as dist
              from candidate_vec
              join finding_vec
            )
            select cid, fid, dist from (
              select cid, fid, dist,
                     row_number() over (partition by cid order by dist asc, fid asc) as rn
              from pair
            )
            where rn = 1`,
    });

    for (const row of typedRows<WinnerRow>(rankedResult.rows)) {
      winners.set(row.cid, row);
    }
  }

  // ── The corpora the write half needs ───────────────────────────────────────────────
  // The pre-audio ladder (affinity + ISRC map) is needed whenever an UNVECTORED row exists, and
  // ALSO when a vectored row has to be QUARANTINED (rewound to the pre-audio ladder). The
  // finding→key identity map is needed only to ADJUDICATE a near-1.0 vectored row — the common
  // tick has none, so those finding-bounded reads stay off the hot path until a row earns them.
  const nearWrongAudio = vectored.filter((row) => {
    const winner = winners.get(row.track_id);

    return (
      row.capture_status !== QUARANTINE_CLEARED &&
      winner !== undefined &&
      1 - Number(winner.dist) >= WRONG_AUDIO_QUARANTINE
    );
  });
  const needsPreAudio = unvectored.length > 0 || nearWrongAudio.length > 0;
  // The graph edges for every row that will run the pre-audio ladder (an unvectored row, or a
  // vectored row about to be QUARANTINED back to it) — ONE batched read for the whole tick.
  const preAudioTrackIds = needsPreAudio
    ? [...unvectored, ...nearWrongAudio].map((row) => row.track_id)
    : [];
  const [
    artistIdsByTrack,
    archive,
    findingIsrcs,
    findingIdentities,
    findingMatchKeys,
    catalogueIdentity,
  ] = await Promise.all([
    readTrackArtistIds(preAudioTrackIds),
    needsPreAudio ? readArchiveAffinity() : undefined,
    needsPreAudio ? readFindingIsrcs() : undefined,
    nearWrongAudio.length > 0 ? readFindingIdentities() : undefined,
    // The INVERTED finding identity map (matchKey → finding) — needed on EVERY tick with
    // candidates, because a matchKey twin of a logged finding (the "Drifting Away" ruling) can
    // hide at ANY score, not just the near-1.0 band: an unvectored row may duplicate a finding
    // by title, and a scored row at 0.94 may be that finding's YouTube-rip twin.
    readFindingMatchKeys(),
    // The catalogue-internal duplicate corpus — needed on EVERY tick with candidates: a vectored
    // row may be a captured sibling of another catalogue row (declutter the ear lens), and an
    // unvectored row may duplicate an already-captured sibling (veto it off the capture queue).
    readCatalogueIdentity(),
  ]);

  // ── The scored half, now with the wrong-audio veto (docs/the-ear.md § Wrong audio) ──
  let quarantined = 0;
  // Vectored rows re-pointed at a canonical catalogue sibling (already-captured duplicates).
  let catalogueDuplicates = 0;

  for (const candidate of vectored) {
    const winner = winners.get(candidate.track_id);
    // `vector_distance_cos` returns 1 − cos, so the similarity is 1 − distance: higher is
    // nearer, and the column sorts DESC. A candidate with no winner (nothing embedded yet, or
    // a malformed stored vector) is stamped with a null score rather than left stale.
    const score = winner ? 1 - Number(winner.dist) : null;

    // THE ADJUDICATION. A cosine of six-plus nines is the SAME MASTER, not a similar track. So a
    // near-1.0 row is one of two things, and the folded title+artist `matchKey` tells them apart:
    if (
      winner &&
      score !== null &&
      score >= WRONG_AUDIO_QUARANTINE &&
      candidate.capture_status !== QUARANTINE_CLEARED &&
      findingIdentities
    ) {
      const rowKey = matchKey(parseArtistsJson(candidate.artists_json), candidate.title);
      const findingKey = findingIdentities.get(winner.fid);
      const sameTitle = findingKey !== undefined && findingKey === rowKey;
      // The operator's force-capture (`DUPLICATE_CLEARED`, docs/the-ear.md § Duplicates) overrules
      // the DUPLICATE veto only: a same-title true-duplicate is NOT re-stamped (it falls through to
      // a normal scored write and ranks on its own merits), but a DIFFERENT-title near-1.0 still
      // QUARANTINES — the escape hatch never bypasses the verification gate.
      const forcedPastDuplicate = candidate.capture_status === DUPLICATE_CLEARED;

      if (sameTitle && !forcedPastDuplicate) {
        // SAME TITLE → a TRUE DUPLICATE. The crawler re-found a track already logged, with the
        // RIGHT audio — worthless to buy but not wrong. Route it to the #545 duplicate handling:
        // name the finding on `duplicate_of_track_id` and stamp the −2 tier (excluded from the
        // capture queue by the existing `capture_priority >= 0` predicate). It KEEPS its vector
        // and score, so it stays on the ear lens reading "already in the archive". The −2 on a
        // vectored row is deliberate, so the staleness predicate's `capture_priority >= 0` clause
        // leaves it stable — no re-pick loop.
        writes.push({
          args: [
            score,
            winner.fid,
            DUPLICATE_CAPTURE_TIER,
            winner.fid,
            corpus,
            now,
            candidate.track_id,
          ],
          sql: `update tracks
                set nearest_finding_score = ?,
                    nearest_finding_track_id = ?,
                    capture_priority = ?,
                    duplicate_of_track_id = ?,
                    catalogue_rank_corpus = ?,
                    catalogue_ranked_at = ?
                where track_id = ?`,
        });
        continue;
      }

      // DIFFERENT TITLE → WRONG AUDIO — but only when the titles DIFFER. A same-title row that
      // reached here was force-captured past the duplicate veto (`DUPLICATE_CLEARED`): it is not
      // wrong audio, so it falls through to the normal scored write below. The escape hatch lifts
      // the DUPLICATE veto only, never the verification gate — a genuine cross-title collision
      // still quarantines here.
      //
      // The capture matched the artist's already-logged hit, so this vector is a lie about what
      // the row is. QUARANTINE: drop the poisoned vector + score (a catalogue row is never
      // anyone's nearest-finding candidate, so nulling it poisons no other ranking), remember the
      // collided finding as the WHY, and re-derive the pre-audio tier so it re-enters the capture
      // queue for a fresh download. `source_audio_key` is KEPT on the row: its embedded sha256 is
      // the memory the capture sweep uses to refuse an identical re-download (docs/the-ear.md §
      // Wrong audio). `capture_status = 'wrong-audio'` is the re-capture trigger AND the
      // embed/analyze guard (track-work.ts). The poisoned capture's sha ALSO enters the GENERAL
      // bad-audio memory, so the re-download's videoId/sha filters refuse it.
      if (!sameTitle) {
        const preAudio = archive
          ? preAudioPriority(
              candidate,
              archive,
              findingIsrcs ?? new Map<string, string>(),
              findingMatchKeys,
              artistIdsByTrack.get(candidate.track_id) ?? [],
            )
          : { duplicateOf: null, priority: 0 };
        quarantined += 1;
        writes.push({
          args: [
            WRONG_AUDIO_STATUS,
            winner.fid,
            preAudio.priority,
            preAudio.duplicateOf,
            appendRejectedSha(
              candidate.source_audio_rejected,
              shaFromSourceAudioKey(candidate.source_audio_key),
              "quarantine",
              now,
            ),
            corpus,
            now,
            candidate.track_id,
          ],
          sql: `update tracks
              set capture_status = ?,
                  embedding_blob = null,
                  nearest_finding_score = null,
                  nearest_finding_track_id = ?,
                  capture_priority = ?,
                  duplicate_of_track_id = ?,
                  source_audio_rejected = ?,
                  catalogue_rank_corpus = ?,
                  catalogue_ranked_at = ?
              where track_id = ?`,
        });
        continue;
      }
    }

    // MATCHKEY-VS-FINDINGS DUPLICATE (the 2026-07-15 "Drifting Away" ruling, docs/the-ear.md §
    // Duplicates). Independent of the near-1.0 adjudication above and of the score entirely: a
    // scored row whose folded title+artist `matchKey` EQUALS a certified finding's is that logged
    // song, even when a YouTube-rip capture only scored a merely-0.94 twin (the exact live case —
    // "Drifting Away" ranked 0.94 against the finding 012.8.0A, the same song). Mirror the
    // same-title −2 write: name the finding on `duplicate_of_track_id`, stamp the −2 tier so it
    // leaves the ear lens (its existing `duplicate_of_track_id is null` filter) while KEEPING its
    // vector + score (the honest WHY of the number). The near-1.0 same-title path already handled
    // its own band above (and `continue`d); this catches the whole rest of the score range. It runs
    // BEFORE the catalogue-internal check because a certified finding is the canonical the board
    // would rather name (the same precedence the pre-audio ladder uses). `DUPLICATE_CLEARED` is
    // respected — a force-captured row is never re-stamped, per the escape hatch.
    const findingDuplicate =
      candidate.capture_status === DUPLICATE_CLEARED
        ? null
        : (findingMatchKeys.get(
            matchKey(parseArtistsJson(candidate.artists_json), candidate.title),
          ) ?? null);

    if (findingDuplicate) {
      writes.push({
        args: [
          score,
          winner?.fid ?? null,
          DUPLICATE_CAPTURE_TIER,
          findingDuplicate,
          corpus,
          now,
          candidate.track_id,
        ],
        sql: `update tracks
              set nearest_finding_score = ?,
                  nearest_finding_track_id = ?,
                  capture_priority = ?,
                  duplicate_of_track_id = ?,
                  catalogue_rank_corpus = ?,
                  catalogue_ranked_at = ?
              where track_id = ?`,
      });
      continue;
    }

    // CATALOGUE-INTERNAL DUPLICATE (docs/the-ear.md § Duplicates). This vectored row is not near
    // a finding, but it may be a captured sibling of another catalogue row — the same master the
    // crawler re-found under a second MusicBrainz MBID. If a canonical sibling exists, mirror the
    // same-title finding-duplicate handling: name the canonical on `duplicate_of_track_id` and
    // stamp the −2 tier so the row leaves the ear lens (the telescope stays one-row-per-recording)
    // while KEEPING its vector + score (it still reads "already in the archive"). Written HERE
    // rather than by a separate pass because the normal path below CLEARS `duplicate_of_track_id`
    // on every scored row — a mark made elsewhere would be wiped on the next tick. The −2 on a
    // vectored row is stable under the staleness predicate's `capture_priority >= 0` guard.
    const canonical = catalogueIdentity ? catalogueDuplicateOf(candidate, catalogueIdentity) : null;

    if (canonical) {
      catalogueDuplicates += 1;
      writes.push({
        args: [
          score,
          winner?.fid ?? null,
          DUPLICATE_CAPTURE_TIER,
          canonical,
          corpus,
          now,
          candidate.track_id,
        ],
        sql: `update tracks
              set nearest_finding_score = ?,
                  nearest_finding_track_id = ?,
                  capture_priority = ?,
                  duplicate_of_track_id = ?,
                  catalogue_rank_corpus = ?,
                  catalogue_ranked_at = ?
              where track_id = ?`,
      });
      continue;
    }

    writes.push({
      args: [
        score,
        winner?.fid ?? null,
        corpus,
        now,
        // A track that HAS audio is not in the capture queue. Clearing the tier keeps the two
        // lenses disjoint: the capture queue is exactly "catalogue, no score yet". The
        // pre-audio duplicate marker is cleared too — it is a capture-ladder concern; a scored
        // duplicate is flagged from its ~1.0 score instead (DUPLICATE_SIMILARITY, display-only).
        candidate.track_id,
      ],
      sql: `update tracks
            set nearest_finding_score = ?,
                nearest_finding_track_id = ?,
                catalogue_rank_corpus = ?,
                catalogue_ranked_at = ?,
                capture_priority = null,
                duplicate_of_track_id = null
            where track_id = ?`,
    });
  }

  // ── The capture half: the pre-audio ladder, in TS, over tiny strings ───────────────
  // No audio, no vector, nothing to rank in SQL. The inputs are a name array and a label —
  // bytes, not vectors — so the one authority for the ladder (`capturePriorityFor`, via
  // `preAudioPriority`) runs here and the surface re-runs the same function to explain the answer.
  if (unvectored.length > 0 && archive) {
    for (const candidate of unvectored) {
      // THE DUPLICATE CHECK, before the ladder. An exact ISRC match — OR, after it misses, a folded
      // title+artist `matchKey` match (the "Drifting Away" ruling: a YouTube rip carries no ISRC) —
      // to a certified finding means buying this row's audio buys something already on file, the
      // money the crawler's real "Infinity" duplicate would have spent. It is the −2 veto tier
      // (excluded by the capture queue's `capture_priority >= 0` predicate, no new mechanism), and
      // the finding it matched is stored so the board can name it. NULL clears a stale marker when
      // the finding is gone.
      const finding = preAudioPriority(
        candidate,
        archive,
        findingIsrcs ?? new Map<string, string>(),
        findingMatchKeys,
        artistIdsByTrack.get(candidate.track_id) ?? [],
      );

      // THEN the catalogue-internal duplicate: this uncaptured row may be the same master as an
      // already-CAPTURED catalogue sibling (a second MusicBrainz MBID for one song). Vetoing it
      // here — before a single byte moves — is the real spend saver: it stops the crawler buying
      // the same track twice. A finding duplicate wins if both fire (the certified row is the
      // canonical the board would rather name). Same −2 tier, same stored-marker mechanism.
      const canonical =
        finding.duplicateOf ??
        (catalogueIdentity ? catalogueDuplicateOf(candidate, catalogueIdentity) : null);
      const duplicateOf = canonical;
      const priority = canonical ? DUPLICATE_CAPTURE_TIER : finding.priority;

      writes.push({
        args: [priority, duplicateOf, corpus, now, candidate.track_id],
        sql: `update tracks
              set capture_priority = ?,
                  duplicate_of_track_id = ?,
                  catalogue_rank_corpus = ?,
                  catalogue_ranked_at = ?,
                  nearest_finding_score = null,
                  nearest_finding_track_id = null
              where track_id = ?`,
      });
    }
  }

  // The rows this tick moves — exactly the candidates (every candidate produced one PK-keyed write).
  // Their summary buckets BEFORE the write, read in one PK-indexed `in (…)` pass bounded by the
  // batch, pair with the AFTER read below into a batch delta.
  const movedIds = candidates.map((candidate) => candidate.track_id);
  const before = await readBatchRowBuckets(movedIds);

  // One implicit write transaction. Every statement is PK-keyed and idempotent, so a retry
  // after a partial failure converges on the same rows.
  await db.batch(writes, "write");

  // The tick's writes have landed. The cached six counts move by a BATCH DELTA — the moved rows'
  // (after − before) buckets, the batched twin of `withSummaryDelta` — NOT the O(catalogue) full
  // recompute (docs/db-scale-backlog Wave 1 #2). During a drain of up to `MAX_CALLS` active ticks
  // that turns ~8 full anti-join scans into one bounded PK read per tick; the idle/drain-end tick
  // (the empty-batch branch above) still does the authoritative `persistCatalogueCaches` recompute
  // that heals any accumulated delta drift. The persisted counts are numerically identical to a full
  // recompute (proved by the batch-delta equivalence test).
  await applyCatalogueSummaryBatchDelta(before, await readBatchRowBuckets(movedIds));

  // The capture-lens affinity cache: refresh it reusing THIS tick's already-read affinity when the
  // pre-audio ladder computed one (`archive`), so the weighted qualified-artist GROUP BY runs once
  // per call, not twice (docs/db-scale-backlog Wave 1 #4). A tick with no pre-audio row reads it
  // live — the same every-tick refresh cadence the display-only chip had before.
  await refreshArchiveAffinityCache(archive);

  // The drain signal. By DEFAULT it is inferred from batch fullness with no scan — a FULL batch
  // consumed exactly `limit` stale rows, so more are stale by construction (the sentinel); a SHORT
  // batch exhausted the stale set (0). `countRemaining` opts into the real live COUNT for the
  // human-facing CLI readout — one ~19s scan on a deliberate manual run, never on the box sweep,
  // which keeps the default sentinel (docs/db-scale-backlog Wave 1 #1).
  let remaining = 0;

  if (countRemaining) {
    remaining = await countStale(corpus);
  } else if (candidates.length >= limit) {
    remaining = RANK_MORE_REMAIN;
  }

  return {
    catalogueDuplicates,
    corpus,
    embeddedFindings,
    findings,
    prioritized: unvectored.length,
    quarantined,
    remaining,
    // A quarantined row was scored, then vetoed — it is no longer a `scored` find. A catalogue
    // duplicate KEEPS its score (it reads "already in the archive"), so it stays a `scored` row.
    scored: vectored.length - quarantined,
  };
}

/** How much of the catalogue is still stale after a tick — the cron's "run me again" signal. */
async function countStale(corpus: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [corpus],
    sql: `select count(*) as n
          from tracks ct
          where ct.is_catalogue = 1
            and ct.dismissed_at is null
            and (ct.catalogue_rank_corpus is null
                 or ct.catalogue_rank_corpus <> ?
                 or (ct.embedding_blob is not null
                     and ct.capture_priority is not null
                     and ct.capture_priority >= 0))`,
  });

  return Number(typedRows<{ n: number }>(result.rows)[0]?.n ?? 0);
}

// ── The reads ────────────────────────────────────────────────────────────────────────

/**
 * Which question the page is asking of the catalogue.
 *
 *   - `ear`        — closest to a finding (the telescope).
 *   - `capture`    — next to capture (the pre-audio ladder).
 *   - `quarantine` — the WRONG-AUDIO holding pen (docs/the-ear.md § Wrong audio): rows whose
 *     capture landed the wrong master, vetoed from the ear lens and re-queued for a fresh
 *     download. Its own quiet section so a bad capture never silently vanishes, each row carrying
 *     the honest reason and a force-clear the operator can use to overrule it.
 *   - `dismissed`  — the operator's "not for me" pile (docs/the-ear.md § The operator's actions):
 *     rows he looked at and took out of the telescope. A REVERSIBLE veto — its own quiet lens so a
 *     dismissal is never a black hole, each row carrying a Restore that puts it back in the ranking.
 */
export type CatalogueLens = "capture" | "dismissed" | "ear" | "failed" | "quarantine" | "unmatched";

/** The finding a catalogue row matched — the WHY, hydrated. */
export type CatalogueMatch = {
  artists: string[];
  logId: string | null;
  title: string;
  trackId: string;
};

/** One catalogue row, in the shape `/admin/catalogue` and the CLI render. */
export type CatalogueTrackItem = {
  albumImageUrl: string | null;
  /** The Apple Music listen link, when the ISRC has resolved one — the Spotify twin. */
  appleMusicUrl: string | null;
  artists: string[];
  bpm: number | null;
  capturePriority: number | null;
  captureReason: CapturePriorityReason | null;
  /**
   * The capture state machine's verdict on this row (`pending` / `done` / `failed` /
   * `unmatched` / `wrong-audio` / the sticky cleared states), or null (never attempted) — the
   * observability field the 2026-07-14 unmatched audit had to pull a prod snapshot for.
   */
  captureStatus: string | null;
  /**
   * The capture-verification verdict (docs/the-ear.md § Wrong audio): `preview-match` (the
   * captured audio matched the ISRC preview), `unverified` (the gate abstained — no reference),
   * `mismatch` (a finding awaiting the operator's ruling), or null (pre-gate legacy / no capture).
   * A quiet honesty marker; the board may whisper `unverified`, never redesign around it.
   */
  captureVerification: string | null;
  /**
   * ISO of when the operator dismissed this row ("not for me"), or null on a live row. Only
   * ever set on a row read through the `dismissed` lens (the restore pile) — every other lens
   * filters dismissed rows out.
   */
  dismissedAt: string | null;
  /**
   * The certified finding this row is the SAME RECORDING as — hydrated, so the board can name
   * it ("already in the archive"). Two paths set it (docs/the-ear.md § Duplicates): the CAPTURE
   * lens from the stored `duplicate_of_track_id` (a pre-audio ISRC match), the EAR lens from
   * `nearestFinding` when the score is ≥ `DUPLICATE_SIMILARITY` (a scored near-1.0 match). Null
   * on an ordinary catalogue row — the common case, an actual discovery.
   */
  duplicateOf: CatalogueMatch | null;
  /**
   * Whether the private bucket holds this row's captured full song — the audition FALLBACK:
   * a row with no resolvable store preview (no URL, no ISRC — the small-label case) still plays
   * the bytes Fluncle owns, through the operator source-audio route.
   */
  hasCapturedAudio: boolean;
  /**
   * Whether an official 30s preview can be auditioned for this row — the operator's inline
   * play control (docs/the-ear.md § The operator's actions). True when the row carries a stored
   * preview URL OR an ISRC (the `/api/preview` relay resolves a fresh Deezer / exact-Apple /
   * fuzzy-iTunes preview by ISRC), so the artwork is a play button rather than a dead one.
   */
  hasPreview: boolean;
  isrc: string | null;
  key: string | null;
  label: string | null;
  /** The nearest finding, hydrated. Null when the row has no score yet. */
  nearestFinding: CatalogueMatch | null;
  /** Cosine similarity to `nearestFinding`, in [-1, 1]. Higher is nearer. */
  nearestFindingScore: number | null;
  rankedAt: string | null;
  releaseDate: string | null;
  spotifyUrl: string | null;
  title: string;
  trackId: string;
};

/** What the operator needs to know about the catalogue as a whole, above the rows. */
export type CatalogueSummary = {
  /** Catalogue rows with a `capture_priority` and no score — the capture queue's depth. */
  awaitingCapture: number;
  /** Catalogue rows the sweep has not reached yet (or that went stale). */
  awaitingRank: number;
  /**
   * When the six counts were last computed (the rank sweep's last tick, or the operator's last
   * count-changing act) — the freshness stamp the page reads. The counts are CACHED, not scanned
   * live (see `getCatalogueSummary`), so this says how fresh they are. Null only on the one-time
   * cold fill of an empty/wiped cache. docs/the-ear.md is explicit that the exact number is
   * near-decorative, so a slightly-stale count is in keeping — this stamp makes the staleness honest.
   */
  computedAt: string | null;
  /** Catalogue rows the operator dismissed ("not for me") — the restore pile's depth. */
  dismissed: number;
  /**
   * Catalogue rows QUARANTINED as wrong audio (docs/the-ear.md § Wrong audio) — awaiting a
   * fresh capture, held in their own lens rather than mixed into the capture queue.
   */
  quarantined: number;
  /**
   * Catalogue rows carrying a `nearest_finding_score` that ARE the ear lens — a real
   * discovery. EXCLUDES the deterministic duplicates (`duplicate_of_track_id` set, an ISRC /
   * same-title identity match: nothing to validate, so they leave the list per Maurice's
   * ruling) and dismissed rows, so this count matches exactly what the ear lens shows.
   */
  ranked: number;
  /** Every live `tracks` row with no `findings` row (dismissed rows excluded). */
  total: number;
};

// ── The cached summary — the six counts come OFF the hot path ─────────────────────────────────
//
// The six counts describe the WHOLE catalogue, so computing them live is O(all catalogue): a
// six-way conditional aggregate over every `tracks` row with no `findings` row. That scan used to
// run on EVERY page load, every focus refetch, and every mutation invalidation — and the crawler
// grows `tracks` by the thousand, so its cost is unbounded (measured ~10 s of pure query time).
//
// So the counts move off the request path, the same shape as the ranking itself (docs/the-ear.md
// § The architecture), on TWO write paths that never scan on a read:
//   · the `rank_catalogue` sweep visits every stale row anyway, so at the end of each tick it does
//     ONE full recompute (`refreshCatalogueSummary`) and stores the six counts on the `settings` KV
//     (the store the kill switches ride) — the authoritative value, and the drift-healer;
//   · each count-changing operator mutation applies a single-row ±1 DELTA (`withSummaryDelta`): it
//     classifies the ONE affected row into its summary buckets before and after the write (two
//     PK-indexed reads — NEVER the O(catalogue) scan) and shifts the cached counts by the
//     difference, so a dismiss/restore/force-capture/clear tap reflects immediately AND stays cheap
//     (the board is a triage surface — the operator taps dozens per session, and a full recompute
//     per tap would re-create on the write side exactly the jank this cache removes on the read side).
//
// `getCatalogueSummary` then does a single cheap KV read. The exact number is near-decorative
// (docs/the-ear.md § The surface — "No count badge"), so a slightly-stale count is in keeping, and
// the `computedAt` stamp makes the staleness honest.
//
// DRIFT & RACES. The delta's read-modify-write on the KV is not transactional, but /admin is
// single-operator, so concurrent count mutations are negligible; and the sweep's full recompute
// re-derives the truth every tick, healing any accumulated drift. The per-row classifier
// (`bucketsForRow`) is a PURE mirror of `computeCatalogueCounts`'s SQL CASE arms, and a drift-guard
// test (catalogue.integration.test.ts) seeds rows in every bucket and asserts the two agree
// bucket-for-bucket — so the delta and the recompute can never silently diverge in shape.

/** The settings-KV key the six counts cache under, as a JSON `CatalogueSummary`. */
const CATALOGUE_SUMMARY_KEY = "catalogue_summary_cache";

/** The settings-KV key the capture lens's archive affinity caches under (display-only — see below). */
const CATALOGUE_AFFINITY_KEY = "catalogue_affinity_cache";

/** The six counts on their own, without the freshness stamp (the shape the scan produces). */
type CatalogueCounts = Omit<CatalogueSummary, "computedAt">;

/** The six summary buckets — the keys of `CatalogueCounts`, and what `bucketsForRow` classifies into. */
export type SummaryBucket = keyof CatalogueCounts;

/** Every summary bucket, for iterating a delta over the cached counts. */
const SUMMARY_BUCKETS: readonly SummaryBucket[] = [
  "awaitingCapture",
  "awaitingRank",
  "dismissed",
  "quarantined",
  "ranked",
  "total",
];

/**
 * Compute the six counts with ONE scoped aggregate — THE expensive read (O(all catalogue)), and
 * the whole reason for the cache. Every count but `dismissed` describes the LIVE working set
 * (`dismissed_at is null`) so the headline numbers and the lens rows agree; `dismissed` is the
 * restore pile, counted on its own. Called only by the sweep and the cold/corrupt-cache read (via
 * `refreshCatalogueSummary`) — NEVER a warm page load, and NEVER a mutation (those apply a ±1 delta).
 * Exported for the drift-guard test that pins `bucketsForRow` to this SQL bucket-for-bucket.
 */
export async function computeCatalogueCounts(): Promise<CatalogueCounts> {
  const db = await getDb();
  const result = await db.execute({
    args: [WRONG_AUDIO_STATUS, WRONG_AUDIO_STATUS],
    sql: `select
            sum(case when ct.dismissed_at is null then 1 else 0 end) as total,
            sum(case when ct.dismissed_at is null
                      and ct.nearest_finding_score is not null
                      and ct.duplicate_of_track_id is null
                      and ct.duration_ms < ${LONG_FORM_MS} then 1 else 0 end) as ranked,
            sum(case when ct.dismissed_at is null
                      and ct.nearest_finding_score is null
                      and ct.capture_priority is not null
                      and ct.capture_status <> ?
                      and ct.duration_ms >= ${MIN_TRACK_MS}
                      and ct.duration_ms < ${LONG_FORM_MS} then 1 else 0 end) as awaiting_capture,
            sum(case when ct.dismissed_at is null
                      and ct.capture_status = ? then 1 else 0 end) as quarantined,
            sum(case when ct.dismissed_at is null
                      and ct.catalogue_rank_corpus is null then 1 else 0 end) as awaiting_rank,
            sum(case when ct.dismissed_at is not null then 1 else 0 end) as dismissed
          from tracks ct
          where ct.is_catalogue = 1`,
  });
  const row = typedRows<{
    awaiting_capture: number | null;
    awaiting_rank: number | null;
    dismissed: number | null;
    quarantined: number | null;
    ranked: number | null;
    total: number | null;
  }>(result.rows)[0];

  return {
    awaitingCapture: Number(row?.awaiting_capture ?? 0),
    awaitingRank: Number(row?.awaiting_rank ?? 0),
    dismissed: Number(row?.dismissed ?? 0),
    quarantined: Number(row?.quarantined ?? 0),
    ranked: Number(row?.ranked ?? 0),
    total: Number(row?.total ?? 0),
  };
}

/**
 * Recompute the six counts (the O(catalogue) scan) and PERSIST them with a fresh stamp. This is the
 * AUTHORITATIVE write and the drift-healer, called on EXACTLY two paths: the rank-sweep tick (which
 * visits every stale row anyway) and the cold/corrupt-cache read. A count-changing MUTATION never
 * calls this — it applies a single-row ±1 delta (`withSummaryDelta`) instead, so an operator tap
 * never pays the scan. Returns the persisted summary.
 */
export async function refreshCatalogueSummary(): Promise<CatalogueSummary> {
  const counts = await computeCatalogueCounts();
  const summary: CatalogueSummary = { ...counts, computedAt: new Date().toISOString() };

  await setSetting(CATALOGUE_SUMMARY_KEY, JSON.stringify(summary));

  return summary;
}

/**
 * The columns a summary-bucket classification reads off one catalogue row (`bucketsForRow`'s input).
 * `captureStatus` is NON-null: `tracks.capture_status` is `NOT NULL DEFAULT 'pending'` (schema.ts),
 * so a fresh crawled row is `'pending'`, never NULL — the discriminator is purely `!== 'wrong-audio'`.
 */
export type BucketRow = {
  capturePriority: null | number;
  captureStatus: string;
  catalogueRankCorpus: null | string;
  dismissedAt: null | string;
  duplicateOfTrackId: null | string;
  durationMs: null | number;
  nearestFindingScore: null | number;
};

/**
 * Which summary buckets a catalogue row contributes to — a PURE mirror of the SQL CASE arms in
 * `computeCatalogueCounts`, one boolean per arm. A row can be in SEVERAL (the six counts are
 * independent accumulators, not a partition), so this returns a set, and a delta shifts each bucket
 * the row entered or left. It mirrors the SQL's three-valued logic where the column is NULLABLE: a
 * NULL `duration_ms` fails `< LONG_FORM`/`>= MIN` (a NULL comparison is not true), written as an
 * explicit `!== null` guard. `capture_status` is NOT NULL (default `'pending'`), so its arm needs no
 * such guard. The drift-guard test pins this to `computeCatalogueCounts` bucket-for-bucket.
 */
export function bucketsForRow(row: BucketRow): Set<SummaryBucket> {
  const buckets = new Set<SummaryBucket>();
  const live = row.dismissedAt === null;

  if (!live) {
    buckets.add("dismissed");

    return buckets;
  }

  // `total`: every live catalogue row.
  buckets.add("total");

  const withinLongForm = row.durationMs !== null && row.durationMs < LONG_FORM_MS;

  // `ranked`: scored, not a stored duplicate, under the long-form line.
  if (row.nearestFindingScore !== null && row.duplicateOfTrackId === null && withinLongForm) {
    buckets.add("ranked");
  }

  // `awaitingCapture`: no score, a pre-audio tier, not quarantined (`capture_status` is NOT NULL, so
  // the arm is a clean `<> 'wrong-audio'`), inside the duration window — the capture lens's own
  // predicate, mirrored exactly.
  if (
    row.nearestFindingScore === null &&
    row.capturePriority !== null &&
    row.captureStatus !== WRONG_AUDIO_STATUS &&
    row.durationMs !== null &&
    row.durationMs >= MIN_TRACK_MS &&
    withinLongForm
  ) {
    buckets.add("awaitingCapture");
  }

  // `quarantined`: the wrong-audio holding pen.
  if (row.captureStatus === WRONG_AUDIO_STATUS) {
    buckets.add("quarantined");
  }

  // `awaitingRank`: the sweep has not stamped a corpus fingerprint yet.
  if (row.catalogueRankCorpus === null) {
    buckets.add("awaitingRank");
  }

  return buckets;
}

/**
 * Classify ONE catalogue row into its summary buckets — a single PK-indexed read, then the pure
 * `bucketsForRow`. Returns an empty set when the row is not a catalogue row (a finding, or gone), so
 * a stray/absent id contributes no delta. Exported for the drift-guard test.
 */
export async function readRowBuckets(trackId: string): Promise<Set<SummaryBucket>> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select ct.capture_priority, ct.capture_status, ct.catalogue_rank_corpus, ct.dismissed_at,
                 ct.duplicate_of_track_id, ct.duration_ms, ct.nearest_finding_score
          from tracks ct
          left join findings cf on cf.track_id = ct.track_id
          where ct.track_id = ? and cf.track_id is null
          limit 1`,
  });
  const row = typedRow<{
    capture_priority: null | number;
    // NOT NULL (default 'pending'); coalesced only to satisfy the driver's nullable row type.
    capture_status: null | string;
    catalogue_rank_corpus: null | string;
    dismissed_at: null | string;
    duplicate_of_track_id: null | string;
    duration_ms: null | number;
    nearest_finding_score: null | number;
  }>(result.rows);

  if (!row) {
    return new Set<SummaryBucket>();
  }

  return bucketsForRow({
    capturePriority: row.capture_priority,
    captureStatus: row.capture_status ?? "pending",
    catalogueRankCorpus: row.catalogue_rank_corpus,
    dismissedAt: row.dismissed_at,
    duplicateOfTrackId: row.duplicate_of_track_id,
    durationMs: row.duration_ms,
    nearestFindingScore: row.nearest_finding_score,
  });
}

/**
 * The summary buckets for a BATCH of catalogue rows — the batched twin of `readRowBuckets`: one
 * PK-indexed `in (…)` read bounded by the batch (never the growing catalogue), then the pure
 * `bucketsForRow` per row. A track absent from the result (a finding, or gone) contributes no
 * buckets, exactly as the single-row read returns an empty set. Powers the rank sweep's per-tick
 * batch delta, so the cached counts move without the O(catalogue) recompute.
 */
async function readBatchRowBuckets(trackIds: string[]): Promise<Map<string, Set<SummaryBucket>>> {
  const byTrack = new Map<string, Set<SummaryBucket>>();

  if (trackIds.length === 0) {
    return byTrack;
  }

  const db = await getDb();
  const result = await db.execute({
    args: trackIds,
    sql: `select ct.track_id, ct.capture_priority, ct.capture_status, ct.catalogue_rank_corpus,
                 ct.dismissed_at, ct.duplicate_of_track_id, ct.duration_ms, ct.nearest_finding_score
          from tracks ct
          left join findings cf on cf.track_id = ct.track_id
          where ct.track_id in (${trackIds.map(() => "?").join(", ")}) and cf.track_id is null`,
  });

  for (const row of typedRows<{
    capture_priority: null | number;
    // NOT NULL (default 'pending'); coalesced only to satisfy the driver's nullable row type.
    capture_status: null | string;
    catalogue_rank_corpus: null | string;
    dismissed_at: null | string;
    duplicate_of_track_id: null | string;
    duration_ms: null | number;
    nearest_finding_score: null | number;
    track_id: string;
  }>(result.rows)) {
    byTrack.set(
      row.track_id,
      bucketsForRow({
        capturePriority: row.capture_priority,
        captureStatus: row.capture_status ?? "pending",
        catalogueRankCorpus: row.catalogue_rank_corpus,
        dismissedAt: row.dismissed_at,
        duplicateOfTrackId: row.duplicate_of_track_id,
        durationMs: row.duration_ms,
        nearestFindingScore: row.nearest_finding_score,
      }),
    );
  }

  return byTrack;
}

/**
 * Apply a single row's bucket transition (`before` → `after`) to the cached summary — a
 * read-modify-write of ±1 per bucket the row entered or left, with a fresh stamp. Clamped at 0 so a
 * transient race can never render a negative count; the sweep's full recompute heals any drift.
 *
 * A cold/corrupt cache is a NO-OP here: there is nothing to delta, and forcing a full recompute on
 * the write is exactly what this path avoids — the next `getCatalogueSummary` read cold-fills it
 * live (the one sanctioned scan), and the row it reads already reflects this mutation.
 */
async function applyCatalogueSummaryDelta(
  before: Set<SummaryBucket>,
  after: Set<SummaryBucket>,
): Promise<void> {
  const cached = await getSetting(CATALOGUE_SUMMARY_KEY);
  const parsed = cached ? parseSummaryCache(cached) : null;

  if (!parsed) {
    return;
  }

  const next: CatalogueSummary = { ...parsed, computedAt: new Date().toISOString() };

  for (const bucket of SUMMARY_BUCKETS) {
    const delta = (after.has(bucket) ? 1 : 0) - (before.has(bucket) ? 1 : 0);

    if (delta !== 0) {
      next[bucket] = Math.max(0, next[bucket] + delta);
    }
  }

  await setSetting(CATALOGUE_SUMMARY_KEY, JSON.stringify(next));
}

/**
 * Apply a BATCH of row bucket transitions to the cached summary in ONE read-modify-write — the
 * batched twin of `applyCatalogueSummaryDelta`, for the rank sweep's per-tick delta. It sums each
 * moved row's (after − before) per bucket and shifts the cached counts once, clamped at 0 per bucket
 * (a transient race can never render a negative count). The contract is the single-row delta's,
 * exactly: a cold/corrupt cache is a NO-OP (the next `getCatalogueSummary` read cold-fills the truth,
 * and the rows it reads already reflect the tick), and the sweep's idle/drain-end full recompute
 * re-derives the authoritative counts and heals any accumulated drift. The persisted result is
 * numerically identical to a full `computeCatalogueCounts` recompute (the batch-delta equivalence
 * test proves delta-application == full-recompute after a batch).
 */
async function applyCatalogueSummaryBatchDelta(
  before: Map<string, Set<SummaryBucket>>,
  after: Map<string, Set<SummaryBucket>>,
): Promise<void> {
  const cached = await getSetting(CATALOGUE_SUMMARY_KEY);
  const parsed = cached ? parseSummaryCache(cached) : null;

  if (!parsed) {
    return;
  }

  const next: CatalogueSummary = { ...parsed, computedAt: new Date().toISOString() };
  const ids = new Set<string>([...before.keys(), ...after.keys()]);

  for (const bucket of SUMMARY_BUCKETS) {
    let delta = 0;

    for (const id of ids) {
      delta += (after.get(id)?.has(bucket) ? 1 : 0) - (before.get(id)?.has(bucket) ? 1 : 0);
    }

    if (delta !== 0) {
      next[bucket] = Math.max(0, next[bucket] + delta);
    }
  }

  await setSetting(CATALOGUE_SUMMARY_KEY, JSON.stringify(next));
}

/**
 * Run a single-row catalogue mutation and keep the cached summary honest with a ±1 DELTA — never the
 * O(catalogue) recompute. Classifies the affected row before and after the write (two PK-indexed
 * reads) and shifts the cached counts by the difference; a write that changed nothing (an idempotent
 * no-op, `changed === false`) skips the delta entirely. `write` performs the mutation and returns
 * whether a row changed. See the module header for the drift/races contract.
 */
async function withSummaryDelta(trackId: string, write: () => Promise<boolean>): Promise<boolean> {
  const before = await readRowBuckets(trackId);
  const changed = await write();

  if (changed) {
    const after = await readRowBuckets(trackId);

    await applyCatalogueSummaryDelta(before, after);
  }

  return changed;
}

/** Parse a cached `CatalogueSummary`, or null when the row is absent/corrupt (→ a live recompute). */
function parseSummaryCache(value: string): CatalogueSummary | null {
  let raw: unknown;

  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }

  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const record = raw as Record<string, unknown>;

  for (const field of [
    "awaitingCapture",
    "awaitingRank",
    "dismissed",
    "quarantined",
    "ranked",
    "total",
  ] as const) {
    if (typeof record[field] !== "number") {
      return null;
    }
  }

  return {
    awaitingCapture: Number(record.awaitingCapture),
    awaitingRank: Number(record.awaitingRank),
    computedAt: typeof record.computedAt === "string" ? record.computedAt : null,
    dismissed: Number(record.dismissed),
    quarantined: Number(record.quarantined),
    ranked: Number(record.ranked),
    total: Number(record.total),
  };
}

/**
 * The catalogue's whole shape in one CHEAP read — the cached counts the rank sweep precomputed,
 * NOT a live scan of the rows (docs/the-ear.md § The surface). This is the read the `/admin/catalogue`
 * loader, its focus refetches, and every mutation invalidation land on, so it must not scan.
 *
 * Fallback: a missing or corrupt cached row (a fresh deploy, a wiped KV, a preview branch) computes
 * the counts ONCE and persists them, then every subsequent read hits the cache and the sweep keeps
 * it fresh. The scan never runs on a warm read.
 */
export async function getCatalogueSummary(): Promise<CatalogueSummary> {
  const cached = await getSetting(CATALOGUE_SUMMARY_KEY);

  if (cached) {
    const parsed = parseSummaryCache(cached);

    if (parsed) {
      return parsed;
    }
  }

  return refreshCatalogueSummary();
}

/** The archive affinity, serialized for the KV (Sets → arrays; reconstructed by `parseAffinityCache`). */
type CachedAffinity = {
  disabledLabels: string[];
  findingArtists: string[];
  findingLabels: string[];
  qualifiedArtists: string[];
  seedLabels: string[];
};

/**
 * Recompute the capture lens's archive affinity and persist it (serialized). Called by the rank
 * sweep, because the affinity's inputs — the findings, the label rulings, and the `track_artists`
 * graph — are EXACTLY the ones the corpus fingerprint tracks (docs/the-ear.md § Self-healing), so a
 * rank tick is the natural moment to refresh it. The cache is DISPLAY-ONLY (it reconstructs the WHY
 * chip on the capture lens; the stored `capture_priority` the queue obeys is authoritative), and its
 * staleness is bounded by the rank cadence — the same tick that re-derives a row's stored tier also
 * re-derives this set, so the chip and the tier never disagree by more than one tick.
 *
 * Pass an ALREADY-READ `affinity` to reuse it instead of re-reading (docs/db-scale-backlog Wave 1
 * #4): the rank tick's pre-audio ladder already ran `readArchiveAffinity` for any unvectored /
 * quarantined row, so threading it here collapses the weighted qualified-artist GROUP BY from twice
 * per call to once. Called with no argument (the idle-tick `persistCatalogueCaches`, where no
 * pre-audio affinity exists) it reads live — the same value, one read.
 */
async function refreshArchiveAffinityCache(affinity?: ArchiveAffinity): Promise<void> {
  const resolved = affinity ?? (await readArchiveAffinity());
  const cached: CachedAffinity = {
    disabledLabels: [...resolved.disabledLabels],
    findingArtists: [...resolved.findingArtists],
    findingLabels: [...resolved.findingLabels],
    qualifiedArtists: [...resolved.qualifiedArtists],
    seedLabels: [...resolved.seedLabels],
  };

  await setSetting(CATALOGUE_AFFINITY_KEY, JSON.stringify(cached));
}

/** A JSON array of strings back into a `Set`, or null when the value is not a clean string array. */
function toStringSet(value: unknown): null | Set<string> {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }

  return new Set(value as string[]);
}

/** Parse a cached `ArchiveAffinity`, or null when the row is absent/corrupt (→ a live read). */
function parseAffinityCache(value: string): ArchiveAffinity | null {
  let raw: unknown;

  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }

  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const disabledLabels = toStringSet(record.disabledLabels);
  const findingArtists = toStringSet(record.findingArtists);
  const findingLabels = toStringSet(record.findingLabels);
  const qualifiedArtists = toStringSet(record.qualifiedArtists);
  const seedLabels = toStringSet(record.seedLabels);

  if (!disabledLabels || !findingArtists || !findingLabels || !qualifiedArtists || !seedLabels) {
    return null;
  }

  return { disabledLabels, findingArtists, findingLabels, qualifiedArtists, seedLabels };
}

/**
 * The archive affinity for the capture lens's WHY chips — the CACHED set the rank sweep wrote,
 * NOT a live read. This is the one affinity read that grows with the crawl on a hot path: the
 * weighted qualified-artist GROUP BY (`readArchiveAffinity`) walks every track on an `enabled`
 * label, and the capture lens ran it on every load. It is DISPLAY-ONLY here (it only reconstructs
 * the reason chip a stored tier already earned), so serving it from cache is safe; a cold or
 * corrupt cache falls back to a live read. Every AUTHORIZATION-critical caller — the sweep, the
 * verification quarantine — still reads `readArchiveAffinity` LIVE, never this.
 */
async function readCaptureLensAffinity(): Promise<ArchiveAffinity> {
  const cached = await getSetting(CATALOGUE_AFFINITY_KEY);

  if (cached) {
    const parsed = parseAffinityCache(cached);

    if (parsed) {
      return parsed;
    }
  }

  return readArchiveAffinity();
}

/**
 * Persist both catalogue caches after a sweep tick — the six counts and the capture-lens affinity.
 * The sweep is the one writer that keeps both fresh off the request path; a mutation refreshes only
 * the counts (it cannot change the affinity's finding/label/graph inputs).
 */
async function persistCatalogueCaches(): Promise<void> {
  await Promise.all([refreshCatalogueSummary(), refreshArchiveAffinityCache()]);
}

type CatalogueRow = {
  album_image_url: string | null;
  apple_music_url: string | null;
  artists_json: string;
  bpm: number | null;
  capture_priority: number | null;
  capture_status: string | null;
  capture_verification: string | null;
  catalogue_ranked_at: string | null;
  dismissed_at: string | null;
  duplicate_of_track_id: string | null;
  has_captured_audio: number;
  isrc: string | null;
  key: string | null;
  label: string | null;
  nearest_finding_score: number | null;
  nearest_finding_track_id: string | null;
  preview_url: string | null;
  release_date: string | null;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

type MatchRow = {
  artists_json: string;
  log_id: string | null;
  title: string;
  track_id: string;
};

const CATALOGUE_SELECT = `ct.track_id, ct.title, ct.artists_json, ct.album_image_url, ct.spotify_url,
  ct.apple_music_url, ct.isrc, ct.preview_url, ct.bpm, ct.key, ct.label, ct.release_date,
  ct.nearest_finding_score, ct.nearest_finding_track_id, ct.capture_priority, ct.capture_status,
  ct.capture_verification, ct.catalogue_ranked_at, ct.duplicate_of_track_id, ct.dismissed_at,
  (ct.source_audio_key is not null) as has_captured_audio`;

/**
 * The Ear's read — and the reason the whole sweep exists.
 *
 * NO VECTOR MATH HAPPENS HERE. Both lenses are an ordered walk of a precomputed, indexed
 * column with the page's LIMIT, so the cost is the page and not the corpus. The anti-join
 * (`findings.track_id is null`) is the catalogue's definition and the guarantee that a
 * certified finding can never appear in this list.
 *
 *   · `ear`     — ORDER BY `nearest_finding_score` DESC. "Closest to your findings, not yet
 *                 logged." Only rows that have a score: a row with no vector has no opinion
 *                 to offer, and a telescope does not guess.
 *   · `capture` — ORDER BY `capture_priority` DESC. Who gets their audio captured next, so
 *                 that they can be embedded, so that The Ear can hear them at all.
 *
 * Each row is returned with its WHY: the `ear` rows carry the hydrated nearest finding (one
 * extra batched read, bounded by the page), and the `capture` rows carry the ladder rung that
 * put them there, re-derived through the SAME pure function the sweep used to write it.
 */
export async function listCatalogueTracks(
  lens: CatalogueLens,
  limit = 50,
): Promise<CatalogueTrackItem[]> {
  const page = Math.min(Math.max(1, limit), 200);
  // The ear lens over-fetches a POOL, not a page: the display-band duplicate filter drops
  // rows, and the diversity re-rank needs candidates beyond the raw top so a decayed clone
  // can be displaced by a fresh artist that scored slightly lower.
  const fetchLimit = lens === "ear" ? Math.min(page * 3 + 25, 500) : page;
  const db = await getDb();
  // EVERY lens but `dismissed` filters `ct.dismissed_at is null`: a dismissed row is out of the
  // telescope and the capture ladder both, and only the `dismissed` lens (the restore pile) shows
  // it. The `ear` lens ALSO drops the deterministic duplicates (`duplicate_of_track_id` set — an
  // ISRC / same-title identity match, nothing to validate; Maurice's ruling): they never occupy a
  // ranked slot.
  const query =
    lens === "ear"
      ? {
          args: [fetchLimit],
          // `duration_ms < LONG_FORM_MS` is the long-form veto (see the constant): a continuous
          // mix's centroid-like vector would otherwise sit at the very top of the telescope.
          sql: `select ${CATALOGUE_SELECT}
                from tracks ct
                left join findings cf on cf.track_id = ct.track_id
                where cf.track_id is null
                  and ct.dismissed_at is null
                  and ct.nearest_finding_score is not null
                  and ct.duplicate_of_track_id is null
                  and ct.duration_ms < ${LONG_FORM_MS}
                order by ct.nearest_finding_score desc, ct.track_id asc
                limit ?`,
        }
      : lens === "quarantine"
        ? {
            // The WRONG-AUDIO holding pen (docs/the-ear.md § Wrong audio): every row a capture
            // poisoned, newest first, carrying the finding it wrongly matched as its WHY.
            args: [WRONG_AUDIO_STATUS, page],
            sql: `select ${CATALOGUE_SELECT}
                  from tracks ct
                  left join findings cf on cf.track_id = ct.track_id
                  where cf.track_id is null and ct.dismissed_at is null and ct.capture_status = ?
                  order by ct.catalogue_ranked_at desc, ct.track_id asc
                  limit ?`,
          }
        : lens === "unmatched" || lens === "failed"
          ? {
              // The OBSERVABILITY lenses (the 2026-07-14 unmatched audit's gap): the terminal
              // `unmatched` verdicts and the cooling `failed` retries, most-recently attempted
              // first — so "what is failing and why" is one read, not a prod snapshot. Read-only
              // windows onto the sweep's outcomes; the rescue (`requeue_unmatched_captures`) and
              // the retry cooldown act on them elsewhere.
              args: [lens, page],
              sql: `select ${CATALOGUE_SELECT}
                    from tracks ct
                    left join findings cf on cf.track_id = ct.track_id
                    where cf.track_id is null and ct.dismissed_at is null and ct.capture_status = ?
                    order by ct.source_audio_attempted_at desc, ct.track_id asc
                    limit ?`,
            }
          : lens === "dismissed"
            ? {
                // The restore pile (docs/the-ear.md § The operator's actions): every "not for me",
                // most-recently dismissed first, each restorable. Driven by the partial
                // `tracks_dismissed_idx`, so the listing is a seek, not a scan of the catalogue.
                args: [page],
                sql: `select ${CATALOGUE_SELECT}
                    from tracks ct
                    left join findings cf on cf.track_id = ct.track_id
                    where cf.track_id is null and ct.dismissed_at is not null
                    order by ct.dismissed_at desc, ct.track_id asc
                    limit ?`,
              }
            : {
                // The capture queue EXCLUDES the quarantined rows — they are a re-capture, held in
                // their own lens, not part of the cold pre-audio queue — and the LONG-FORM rows
                // (the veto's money half: a mix is the fattest thing the metered budget can buy).
                //
                // The tiebreak is `track_id DESC` (not ASC) so the WHOLE `order by … DESC, … DESC`
                // is ONE reverse walk of the ASC `(capture_priority, track_id)` partial index, which
                // stops at LIMIT — a mixed `DESC, ASC` cannot ride the composite index and forces a
                // temp-B-tree sort over the entire uncaptured set (which IS the crawler's output). The
                // tiebreak exists only for a deterministic order among equal-priority rows; its
                // direction is arbitrary, so nothing depends on it (there is no keyset pagination on
                // this lens — just LIMIT).
                args: [WRONG_AUDIO_STATUS, page],
                sql: `select ${CATALOGUE_SELECT}
                    from tracks ct
                    left join findings cf on cf.track_id = ct.track_id
                    where cf.track_id is null
                      and ct.dismissed_at is null
                      and ct.nearest_finding_score is null
                      and ct.capture_priority is not null
                      and ct.capture_status <> ?
                      and ct.duration_ms >= ${MIN_TRACK_MS}
                      and ct.duration_ms < ${LONG_FORM_MS}
                    order by ct.capture_priority desc, ct.track_id desc
                    limit ?`,
              };
  const result = await db.execute(query);
  const rows = typedRows<CatalogueRow>(result.rows);

  if (rows.length === 0) {
    return [];
  }

  // The findings this page names — ONE batched read, whichever lens. The `ear` and `quarantine`
  // lenses hydrate the nearest finding (the WHY — a match, or the collision that poisoned the
  // capture); the `capture` lens hydrates the finding a pre-audio ISRC match flagged as a
  // duplicate (docs/the-ear.md).
  const matches = await hydrateMatches(
    rows.map((row) =>
      lens === "capture" ? row.duplicate_of_track_id : row.nearest_finding_track_id,
    ),
  );
  // The capture lens's WHY chips read the CACHED affinity (the rank sweep wrote it), never the live
  // weighted qualified-artist GROUP BY that grows with the crawl — this is display-only, so a cold
  // cache falls back to a live read (`readCaptureLensAffinity`). Authorization-critical callers (the
  // sweep, the quarantine) still read `readArchiveAffinity` live.
  const archive = lens === "capture" ? await readCaptureLensAffinity() : undefined;
  // The capture lens re-derives each row's WHY through the SAME pure ladder the sweep wrote it
  // with, so the two cannot drift — and that now needs the row's graph edges for the artist-driven
  // authorization gate (RFC artist-primary-capture, slice 1). ONE batched read for the page.
  const artistIdsByTrack =
    lens === "capture" ? await readTrackArtistIds(rows.map((row) => row.track_id)) : undefined;

  const items = rows.map((row) => {
    const artists = parseArtistsJson(row.artists_json);
    const nearestFinding = row.nearest_finding_track_id
      ? (matches.get(row.nearest_finding_track_id) ?? null)
      : null;

    // The DUPLICATE marker — "already in the archive", the same finding surfaced two ways
    // (docs/the-ear.md § Duplicates). The capture lens reads the STORED pre-audio ISRC match;
    // the ear lens reads a near-1.0 SCORE, display-only, off the same nearest finding.
    const duplicateOf =
      lens === "ear"
        ? typeof row.nearest_finding_score === "number" &&
          row.nearest_finding_score >= DUPLICATE_SIMILARITY
          ? nearestFinding
          : null
        : row.duplicate_of_track_id
          ? (matches.get(row.duplicate_of_track_id) ?? null)
          : null;

    return {
      albumImageUrl: row.album_image_url,
      appleMusicUrl: row.apple_music_url,
      artists,
      bpm: row.bpm,
      capturePriority: row.capture_priority,
      captureReason: archive
        ? ladderTierForRow(
            { artistIds: artistIdsByTrack?.get(row.track_id) ?? [], artists, label: row.label },
            archive,
            row.capture_status === DUPLICATE_CLEARED,
          ).reason
        : null,
      captureStatus: row.capture_status,
      captureVerification: row.capture_verification,
      dismissedAt: row.dismissed_at,
      duplicateOf,
      // Whether the private bucket holds this row's captured full song — the audition
      // FALLBACK: a row with no resolvable store preview (no URL, no ISRC — the small-label
      // case) can still play the bytes Fluncle actually owns, via the admin source-audio route.
      hasCapturedAudio: Number(row.has_captured_audio) === 1,
      // The `/api/preview` relay resolves a fresh preview by ISRC (Deezer → exact Apple →
      // fuzzy iTunes), so a stored URL OR an ISRC means the artwork is a live play control.
      hasPreview: Boolean(row.preview_url) || Boolean(row.isrc && row.isrc.trim()),
      isrc: row.isrc,
      key: row.key,
      label: row.label,
      nearestFinding,
      nearestFindingScore: row.nearest_finding_score,
      rankedAt: row.catalogue_ranked_at,
      releaseDate: row.release_date,
      spotifyUrl: row.spotify_url,
      title: row.title,
      trackId: row.track_id,
    };
  });

  // A row the ear itself marked "already in the archive" (the ≥ DUPLICATE_SIMILARITY display
  // band — a near-1.0 match on the finding it scored against) never occupies a ranked slot:
  // a known duplicate is not a discovery, and its perfect score would sit above every real
  // one (the operator's ruling, 2026-07-15 — the Anwius "Trust" case). The marker itself
  // stays display-only; only the EAR ranking excludes it. The survivors then pass through
  // the diversity decay (EAR_DIVERSITY_DECAY) before the page is cut.
  if (lens === "ear") {
    return diversifyEarPage(
      items.filter((item) => item.duplicateOf === null),
      page,
    );
  }

  return items;
}

/**
 * What the diversity decay reads off a candidate: the raw score to decay and the
 * three redundancy signals. `null` for a missing signal contributes no factor.
 */
export type DiversitySignals = {
  artist: null | string;
  key: null | string;
  score: number;
  year: null | string;
};

/**
 * The greedy diversified selection (EAR_DIVERSITY_DECAY): repeatedly pick the candidate whose
 * raw score, decayed by how many already-picked rows share its artist / year / key, is highest.
 * O(pool × page) over a ≤500 pool — pennies. Deterministic: ties break on the raw order the
 * pool arrived in (score DESC, track_id ASC).
 *
 * GENERIC over the candidate type so the one decay serves both rankings that need it: the ear
 * lens (`CatalogueTrackItem`, via `diversifyEarPage` below) and the per-user recommendation
 * engine (recommendations.ts) — same dials, same greed, never re-implemented.
 */
export function diversifyRanked<T>(
  pool: T[],
  page: number,
  signalsOf: (item: T) => DiversitySignals,
): T[] {
  const picked: T[] = [];
  const artistSeen = new Map<string, number>();
  const yearSeen = new Map<string, number>();
  const keySeen = new Map<string, number>();
  const remaining = [...pool];

  while (picked.length < page && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (const [index, item] of remaining.entries()) {
      const { artist, key, score, year } = signalsOf(item);
      const decayed =
        score *
        EAR_DIVERSITY_DECAY.artist ** (artist ? (artistSeen.get(artist) ?? 0) : 0) *
        EAR_DIVERSITY_DECAY.year ** (year ? (yearSeen.get(year) ?? 0) : 0) *
        EAR_DIVERSITY_DECAY.key ** (key ? (keySeen.get(key) ?? 0) : 0);

      if (decayed > bestScore) {
        bestScore = decayed;
        bestIndex = index;
      }
    }

    const [chosen] = remaining.splice(bestIndex, 1);

    if (chosen === undefined) {
      break;
    }

    const { artist, key, year } = signalsOf(chosen);

    if (artist) {
      artistSeen.set(artist, (artistSeen.get(artist) ?? 0) + 1);
    }

    if (year) {
      yearSeen.set(year, (yearSeen.get(year) ?? 0) + 1);
    }

    if (key) {
      keySeen.set(key, (keySeen.get(key) ?? 0) + 1);
    }

    picked.push(chosen);
  }

  return picked;
}

/** The ear lens's decay pass — `diversifyRanked` bound to the catalogue row's signals. */
function diversifyEarPage(pool: CatalogueTrackItem[], page: number): CatalogueTrackItem[] {
  return diversifyRanked(pool, page, (item) => ({
    artist: item.artists[0] ? item.artists[0].trim().toLowerCase() : null,
    key: item.key ? item.key.trim().toLowerCase() : null,
    score: item.nearestFindingScore ?? 0,
    year: item.releaseDate ? item.releaseDate.slice(0, 4) : null,
  }));
}

/** Hydrate the page's matched findings in ONE batched read (never N+1), keyed by track id. */
async function hydrateMatches(findingIds: (string | null)[]): Promise<Map<string, CatalogueMatch>> {
  const ids = [...new Set(findingIds.filter((id): id is string => typeof id === "string"))];

  if (ids.length === 0) {
    return new Map();
  }

  const db = await getDb();
  const result = await db.execute({
    args: ids,
    sql: `select tracks.track_id, tracks.title, tracks.artists_json, findings.log_id
          from findings
          join tracks on tracks.track_id = findings.track_id
          where tracks.track_id in (${ids.map(() => "?").join(", ")})`,
  });

  return new Map(
    typedRows<MatchRow>(result.rows).map((row) => [
      row.track_id,
      {
        artists: parseArtistsJson(row.artists_json),
        logId: row.log_id,
        title: row.title,
        trackId: row.track_id,
      },
    ]),
  );
}

/**
 * THE OPERATOR FORCE-CLEAR (`clear_wrong_audio`) — "I disagree, this capture is fine, stop
 * re-capturing it" (docs/the-ear.md § Wrong audio). It flips a quarantined row's `capture_status`
 * from `wrong-audio` to `quarantine-cleared`, a STICKY override the `rank_catalogue` sweep never
 * re-quarantines: the operator's ruling wins exactly like his note wins over the auto-note.
 *
 * The row's kept audio re-embeds on the next `embed` tick (the guard is `<> 'wrong-audio'`, which
 * `quarantine-cleared` passes) and then re-ranks normally — reading as a duplicate if it genuinely
 * matches the finding, or a discovery if it does not. It is a no-op success on a row that is not
 * actually quarantined (a double-click, a race), and only ever touches a CATALOGUE row — a finding
 * has no quarantine state. Returns whether a row was flipped, so the caller can report honestly.
 */
export async function clearWrongAudio(trackId: string): Promise<boolean> {
  // A cleared row leaves `quarantined` (and may enter `awaitingCapture`) — `withSummaryDelta` shifts
  // the cached counts by the row's own before/after buckets, so the operator's tap reflects
  // immediately without the O(catalogue) recompute (docs/the-ear.md § the surface).
  return withSummaryDelta(trackId, async () => {
    const db = await getDb();
    const result = await db.execute({
      args: [QUARANTINE_CLEARED, trackId, WRONG_AUDIO_STATUS],
      sql: `update tracks
          set capture_status = ?
          where track_id = ?
            and capture_status = ?
            and not exists (select 1 from findings where findings.track_id = tracks.track_id)`,
    });

    return result.rowsAffected > 0;
  });
}

/**
 * THE OPERATOR UNMATCHED RESCUE (`requeue_unmatched_captures`) — flip the terminal
 * `unmatched` verdicts back to `pending` after a MATCHER improvement (the 2026-07-14
 * search-ladder upgrade). `unmatched` is terminal so the metered budget never re-burns a
 * hopeless search; when the search itself gets better, the old verdicts describe the old
 * matcher, not the tracks. One deliberate operator act, not a sweep behavior.
 *
 * The duration vetoes are honored HERE too: a row the capture queue would refuse anyway
 * (missing duration, < MIN_TRACK_MS, ≥ LONG_FORM_MS) stays terminal — re-queueing it buys a
 * guaranteed-unmatched billed search. Those are counted honestly as `skippedVetoed`.
 * `source_audio_failures` resets so the rescued rows start their retry ledger clean.
 * Catalogue rows only (a finding's unmatched is rescued by its own re-capture flows).
 */
export async function requeueUnmatchedCaptures(): Promise<{
  requeued: number;
  skippedVetoed: number;
}> {
  const db = await getDb();
  const vetoed = await db.execute({
    sql: `select count(*) as vetoed
          from tracks
          where capture_status = 'unmatched'
            and not exists (select 1 from findings where findings.track_id = tracks.track_id)
            and (duration_ms is null
                 or duration_ms < ${MIN_TRACK_MS}
                 or duration_ms >= ${LONG_FORM_MS})`,
  });
  const result = await db.execute({
    sql: `update tracks
          set capture_status = 'pending',
              source_audio_failures = 0
          where capture_status = 'unmatched'
            and not exists (select 1 from findings where findings.track_id = tracks.track_id)
            and duration_ms >= ${MIN_TRACK_MS}
            and duration_ms < ${LONG_FORM_MS}`,
  });

  return {
    requeued: result.rowsAffected,
    skippedVetoed: Number(typedRows<{ vetoed: number | null }>(vetoed.rows)[0]?.vetoed ?? 0),
  };
}

/**
 * THE OPERATOR FORCE-CAPTURE (`forceCapture`) — the dupe-veto escape hatch (docs/the-ear.md §
 * Duplicates). "This row is NOT the duplicate the sweep thinks it is." A duplicate veto can be
 * WRONG in rare cases — a shared or mis-assigned ISRC, a `matchKey` collision on a genuinely
 * different recording — and the veto is self-sealing: an uncaptured row marked `duplicate_of` +
 * the −2 tier is excluded from capture forever, so the post-audio similarity check that would
 * exonerate it never runs (the track never gets audio to embed). This is the only exit.
 *
 * It stamps the STICKY `DUPLICATE_CLEARED` `capture_status` — the `clearWrongAudio` precedent for
 * the OTHER self-sealing verdict — which all three duplicate detectors respect (`preAudioPriority`,
 * the scored-path same-title adjudication, `catalogueDuplicateOf`/`readCatalogueIdentity`), so the
 * self-healing re-rank never re-marks the row. In the same write it CLEARS the veto (`duplicate_of`
 * null, `capture_priority` null) and NULLS `catalogue_rank_corpus` so the row goes stale and the
 * next tick re-ranks it: an UNCAPTURED row lands back on the pre-audio ladder at its HONEST tier
 * and the next open-budget capture tick buys it (the capture work queue treats `duplicate-cleared`
 * as capture-eligible); a CAPTURED sibling re-scores and rejoins the ear lens as a discovery.
 *
 * IT BYPASSES THE DUPLICATE VETO, NEVER THE VERIFICATION GATE — a re-captured forced row still runs
 * the #578 fingerprint gate at ingest, and a wrong-audio (cross-title near-1.0) capture still
 * quarantines. Getting the row captured is the point: its OWN vector is what lets the finding-side
 * detectors settle it honestly.
 *
 * Guarded to a CATALOGUE row that is ACTUALLY vetoed (`duplicate_of_track_id is not null`): a
 * no-op success on any other row (a non-duplicate, a finding), so a double-click reports honestly.
 * Returns whether the veto was lifted.
 */
export async function forceCapture(trackId: string): Promise<boolean> {
  // Force-capture nulls the tier + the corpus, so the row moves between the capture/awaiting-rank
  // (and ranked) buckets — `withSummaryDelta` shifts the cached counts by its before/after buckets,
  // no full recompute.
  return withSummaryDelta(trackId, async () => {
    const db = await getDb();
    const result = await db.execute({
      args: [DUPLICATE_CLEARED, trackId],
      sql: `update tracks
          set capture_status = ?,
              duplicate_of_track_id = null,
              capture_priority = null,
              catalogue_rank_corpus = null
          where track_id = ?
            and duplicate_of_track_id is not null
            and not exists (select 1 from findings where findings.track_id = tracks.track_id)`,
    });

    return result.rowsAffected > 0;
  });
}

/**
 * THE OPERATOR FLAG (`flag_wrong_audio`) — "the FINDING's capture is the wrong one" (docs/
 * the-ear.md § Wrong audio). The auto-quarantine can only ever accuse the CATALOGUE side of a
 * cross-title collision, but six-nines cosine proves same-recording, not which title is lying:
 * when the operator auditions the catalogue row's captured bytes and hears the row's OWN song,
 * the poisoned capture is the finding's. This is his way to say so.
 *
 * It applies the same rewind the sweep applies to a quarantined catalogue row, aimed at the
 * finding: `capture_status = 'wrong-audio'` (the re-capture trigger AND the embed/analyze guard),
 * the poisoned vector dropped (it was silently warping every ranking scored against it), and
 * `analyzed_from` nulled so the post-re-capture sweep re-enriches (bpm/key/features were measured
 * off the wrong song; `shouldReenrichAfterCapture` keys off exactly this). `source_audio_key` is
 * KEPT — its embedded sha256 is what the capture sweep uses to refuse an identical re-download.
 *
 * Dropping the finding's vector moves the corpus fingerprint (`<findings>:<embedded>`), so every
 * catalogue ranking heals itself on the next sweep ticks — including un-scoring the fake ~1.0
 * rows this finding manufactured. Findings-only (the mirror of `clearWrongAudio`'s catalogue-only
 * guard) and captured-only; a no-op success otherwise, so a double-click reports honestly.
 *
 * The poisoned sha ALSO enters the GENERAL bad-audio memory (the general form of the legacy
 * key-derived check, kept alongside it), and `capture_verification` is NULLED so the fresh capture
 * is re-verified from scratch — a flagged finding was verified `mismatch` by the backfill, and that
 * verdict is stale the instant it re-enters the capture queue.
 */
export async function flagWrongAudio(trackId: string): Promise<boolean> {
  const db = await getDb();
  const now = new Date().toISOString();

  // Read the row's key + prior memory under the SAME guard the write applies, so the memory is
  // computed only for a row that actually qualifies (a captured finding not already quarantined).
  const rowResult = await db.execute({
    args: [trackId],
    sql: `select source_audio_key, source_audio_rejected
          from tracks
          where track_id = ?
            and source_audio_key is not null
            and capture_status <> 'wrong-audio'
            and exists (select 1 from findings where findings.track_id = tracks.track_id)
          limit 1`,
  });
  const row = typedRow<{ source_audio_key: null | string; source_audio_rejected: null | string }>(
    rowResult.rows,
  );

  if (!row) {
    return false;
  }

  const rejected = appendRejectedSha(
    row.source_audio_rejected,
    shaFromSourceAudioKey(row.source_audio_key),
    "flag-wrong-audio",
    now,
  );

  const result = await db.execute({
    args: [WRONG_AUDIO_STATUS, rejected, trackId],
    sql: `update tracks
          set capture_status = ?,
              embedding_blob = null,
              analyzed_from = null,
              capture_verification = null,
              source_audio_rejected = ?
          where track_id = ?
            and source_audio_key is not null
            and capture_status <> 'wrong-audio'
            and exists (select 1 from findings where findings.track_id = tracks.track_id)`,
  });

  return result.rowsAffected > 0;
}

/**
 * THE OPERATOR'S "NOT FOR ME" (docs/the-ear.md § The operator's actions) — a REVERSIBLE veto on a
 * catalogue row. `dismissed: true` stamps `dismissed_at` so the row drops out of the ear/capture
 * reads and the capture work queue (track-work.ts); `dismissed: false` clears it, so the row
 * re-enters the ranking on the next sweep tick (its fingerprint is untouched, so it re-ranks only
 * if the corpus moved while it was out).
 *
 * It is the ruled-out-label veto's class: it steers what Fluncle KEEPS pointing at and what the
 * capture ladder may BUY, and it changes nothing else the row stores. It only ever touches a
 * CATALOGUE row — a finding has no dismissal (the `not exists` guard), so a stray finding trackId
 * is a no-op. Returns whether a row actually changed, so the caller reports honestly (a double
 * dismiss / restore is an idempotent no-op success).
 */
export async function setTrackDismissed(trackId: string, dismissed: boolean): Promise<boolean> {
  // Dismissing/restoring moves a row between the live buckets ({total, …}) and the restore pile
  // ({dismissed}) — `withSummaryDelta` shifts the cached counts by the row's own before/after
  // buckets, so the thumbs-down (and its Undo) reflect immediately without the page ever scanning.
  // This is the mutation the "counts stay consistent with the lenses" test exercises after a tick.
  return withSummaryDelta(trackId, async () => {
    const db = await getDb();
    const result = dismissed
      ? await db.execute({
          args: [new Date().toISOString(), trackId],
          sql: `update tracks
              set dismissed_at = ?
              where track_id = ?
                and dismissed_at is null
                and not exists (select 1 from findings where findings.track_id = tracks.track_id)`,
        })
      : await db.execute({
          args: [trackId],
          sql: `update tracks
              set dismissed_at = null
              where track_id = ?
                and dismissed_at is not null
                and not exists (select 1 from findings where findings.track_id = tracks.track_id)`,
        });

    return result.rowsAffected > 0;
  });
}

// ── CAPTURE VERIFICATION (docs/the-ear.md § Wrong audio) ──────────────────────────────
// The historic backfill (verify-captures.ts) fingerprints every captured row against its ISRC
// preview and reports one of three verdicts here; this module ROUTES that verdict to the right
// action, so the doctrine lives server-side (one authority, integration-tested) and the box script
// stays dumb. The INGEST gate (capture-sweep.ts) stamps `preview-match`/`unverified` inline on its
// own store and never reaches this path — it only ever produces those two, and rejects a mismatch
// before storing.

/** One row the backfill still has to verify — enough to fetch its preview + captured bytes. */
export type CaptureVerifyItem = {
  artists: string[];
  certified: boolean;
  /** The stored length — the backfill's TITLE+ARTIST rung guards a search hit against it. */
  durationMs: number;
  isrc: null | string;
  /** Null for a catalogue row (the coordinate lives on the certification). */
  logId: null | string;
  sourceAudioKey: string;
  title: string;
  trackId: string;
};

/** The backfill's verdict for one captured file against its official preview. */
export type CaptureVerifyVerdict = "match" | "mismatch" | "no-preview";

/** What `verifyCapture` did — for the sweep's honest per-row summary. */
export type CaptureVerifyAction =
  | "flagged-finding"
  | "not-captured"
  | "preview-match"
  | "quarantined-catalogue"
  | "unverified";

type VerifyRow = {
  artists_json: string;
  capture_status: null | string;
  certified: number;
  isrc: null | string;
  label: null | string;
  source_audio_key: null | string;
  source_audio_rejected: null | string;
  title: string;
};

/**
 * The backfill's worklist — captured rows (findings + catalogue) not yet verified, bounded and
 * resumable. A stamped row leaves the `capture_verification is null` set, so re-running simply
 * picks up what is left (the embed-queue pattern) — no cursor to persist. Quarantined
 * (`wrong-audio`) rows are excluded: their key points at bytes pending a fresh capture, which the
 * gate will re-verify. Ordered by `track_id` for a deterministic, stable drain.
 */
export async function listUnverifiedCaptures(limit = 50): Promise<CaptureVerifyItem[]> {
  const page = Math.min(Math.max(1, Math.trunc(limit)), 200);
  const db = await getDb();
  const result = await db.execute({
    args: [WRONG_AUDIO_STATUS, page],
    sql: `select ct.track_id as track_id, ct.title as title, ct.artists_json as artists_json,
                 ct.isrc as isrc, ct.duration_ms as duration_ms, ct.source_audio_key as source_audio_key,
                 f.log_id as log_id, (f.track_id is not null) as certified
          from tracks ct
          left join findings f on f.track_id = ct.track_id
          where ct.source_audio_key is not null
            and ct.capture_verification is null
            and (ct.capture_status is null or ct.capture_status <> ?)
          order by ct.track_id asc
          limit ?`,
  });

  return typedRows<{
    artists_json: string;
    certified: number;
    duration_ms: null | number;
    isrc: null | string;
    log_id: null | string;
    source_audio_key: string;
    title: string;
    track_id: string;
  }>(result.rows).map((row) => ({
    artists: parseArtistsJson(row.artists_json),
    certified: Number(row.certified) === 1,
    durationMs: Number(row.duration_ms) || 0,
    isrc: row.isrc,
    logId: row.log_id,
    sourceAudioKey: row.source_audio_key,
    title: row.title,
    trackId: row.track_id,
  }));
}

/**
 * ROUTE a backfill verdict to its action (docs/the-ear.md § Wrong audio):
 *
 *   - `match`      → stamp `capture_verification = 'preview-match'`. The good case.
 *   - `no-preview` → stamp `'unverified'` (the honest abstain — no reference to check against).
 *   - `mismatch` on a FINDING → stamp `'mismatch'` only. A machine does NOT rewind a public
 *     finding: this raises the /admin attention item, and the OPERATOR rules with `flag_wrong_audio`.
 *   - `mismatch` on a CATALOGUE row → QUARANTINE it (the sweep's rewind): drop the vector + score,
 *     re-derive the pre-audio tier so it re-enters the capture queue, remember the poisoned sha in
 *     the bad-audio memory, and stamp `capture_status = 'wrong-audio'`. No operator in the loop —
 *     a catalogue row is not something Fluncle has spoken about.
 *
 * A row with no captured audio (or already quarantined) is a `not-captured` no-op. Returns the
 * action taken so the sweep reports honestly.
 */
export async function verifyCapture(
  trackId: string,
  verdict: CaptureVerifyVerdict,
): Promise<CaptureVerifyAction> {
  const db = await getDb();
  const now = new Date().toISOString();

  const rowResult = await db.execute({
    args: [trackId],
    sql: `select ct.artists_json as artists_json, ct.label as label, ct.isrc as isrc,
                 ct.capture_status as capture_status, ct.source_audio_key as source_audio_key,
                 ct.source_audio_rejected as source_audio_rejected, ct.title as title,
                 (f.track_id is not null) as certified
          from tracks ct
          left join findings f on f.track_id = ct.track_id
          where ct.track_id = ? limit 1`,
  });
  const row = typedRow<VerifyRow>(rowResult.rows);

  // Nothing to verify: no bytes on file, or the row is already quarantined (pending a fresh
  // capture the gate will verify). Either way, a no-op the sweep reports as `not-captured`.
  if (!row || !row.source_audio_key || row.capture_status === WRONG_AUDIO_STATUS) {
    return "not-captured";
  }

  const certified = Number(row.certified) === 1;

  if (verdict === "match" || verdict === "no-preview") {
    const verification = verdict === "match" ? "preview-match" : "unverified";

    await db.execute({
      args: [verification, now, trackId],
      sql: `update tracks set capture_verification = ?, capture_verified_at = ? where track_id = ?`,
    });

    return verification;
  }

  // A MISMATCH on a FINDING — stamp the suspicion, raise the attention item, do NOT rewind.
  if (certified) {
    await db.execute({
      args: [now, trackId],
      sql: `update tracks set capture_verification = 'mismatch', capture_verified_at = ? where track_id = ?`,
    });

    return "flagged-finding";
  }

  // A MISMATCH on a CATALOGUE row — quarantine it (the machine may rewind an uncertified row).
  const [archive, findingIsrcs, findingMatchKeys, artistIdsByTrack] = await Promise.all([
    readArchiveAffinity(),
    readFindingIsrcs(),
    readFindingMatchKeys(),
    readTrackArtistIds([trackId]),
  ]);
  const preAudio = preAudioPriority(
    { artists_json: row.artists_json, isrc: row.isrc, label: row.label, title: row.title },
    archive,
    findingIsrcs,
    findingMatchKeys,
    artistIdsByTrack.get(trackId) ?? [],
  );
  const rejected = appendRejectedSha(
    row.source_audio_rejected,
    shaFromSourceAudioKey(row.source_audio_key),
    "backfill-mismatch",
    now,
  );

  // `capture_verification = 'mismatch'` is KEPT on the quarantined row — it is the lens's honest
  // WHY (a preview-mismatch quarantine, not a cross-title archive collision), and it can never
  // reach the finding attention read (that read joins `findings`, and this row has none). The
  // fresh capture's ingest gate overwrites it with a new verdict when the re-download lands.
  //
  // A backfill quarantine adds to `quarantined` and nulls the corpus/score (→ awaiting-rank, out of
  // ranked), so the cached summary is kept honest with the SAME single-row ±1 delta the operator
  // mutations use — classify before, write, classify after. Only this catalogue-mismatch branch
  // moves a bucket (the match/no-preview stamps and the finding-mismatch branch touch none, so they
  // never refresh), and the per-row delta means it does not multiply the backfill's scans at all.
  const before = await readRowBuckets(trackId);

  await db.execute({
    args: [WRONG_AUDIO_STATUS, preAudio.priority, preAudio.duplicateOf, rejected, now, trackId],
    sql: `update tracks
          set capture_status = ?,
              embedding_blob = null,
              nearest_finding_score = null,
              capture_priority = ?,
              duplicate_of_track_id = ?,
              source_audio_rejected = ?,
              capture_verification = 'mismatch',
              capture_verified_at = ?,
              catalogue_rank_corpus = null
          where track_id = ?`,
  });

  await applyCatalogueSummaryDelta(before, await readRowBuckets(trackId));

  return "quarantined-catalogue";
}
