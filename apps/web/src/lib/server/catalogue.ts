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
import { getDb, typedRows } from "./db";
import { embeddingVectorSql } from "./embedding";
import { labelSlug } from "./labels";
import { matchKey } from "./track-match";

// ── The pre-audio capture ladder ─────────────────────────────────────────────────────

/**
 * The reason a catalogue track sits where it does in the CAPTURE queue — the row's WHY,
 * before it has any audio to measure. `kind` is the ladder rung; `name` is the thing that
 * matched (the artist, or the label), and is null only for `none`.
 */
export type CapturePriorityReason = {
  kind: "artist" | "label" | "none" | "seed-label" | "skipped-label";
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
 */
const CAPTURE_TIER: Record<CapturePriorityReason["kind"], number> = {
  artist: 3,
  label: 2,
  none: 0,
  "seed-label": 1,
  "skipped-label": -1,
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

/** The archive's cheap identity sets — bounded by the FINDING count, never the catalogue. */
export type ArchiveAffinity = {
  /** Label slugs the operator ruled OUT (`labels.seed_state = 'disabled'`) — "not our lane". */
  disabledLabels: Set<string>;
  /** Lowercased names of every artist on a finding. */
  findingArtists: Set<string>;
  /** Label slugs that already carry a finding. */
  findingLabels: Set<string>;
  /** Label slugs the operator rules the crawler may seed from (`labels.seed_state = 'enabled'`). */
  seedLabels: Set<string>;
};

/** A catalogue track's identity, in the shape the capture ladder needs. */
export type CaptureCandidate = { artists: string[]; label: string | null };

/**
 * Where a not-yet-captured catalogue track sits in the capture queue, and why.
 *
 * The ladder, strongest first — each rung is a claim about how likely Fluncle is to love a
 * track we have never heard:
 *
 *   ✗ · `skipped-label` — THE VETO, checked FIRST. Its label is one the operator ruled OUT
 *                      ("not our lane"). Tier 0, no matter what else is true of the track.
 *   3 · `artist`     — an artist on it is ALREADY on a finding. The strongest signal there
 *                      is: his ear has said yes to this artist, so a different tune of
 *                      theirs is the likeliest thing in the catalogue to land.
 *   2 · `label`      — its label already carries a finding. A DnB label is a curator; a
 *                      label he has found on is a crate he digs in.
 *   1 · `seed-label` — its label is one he rules the crawler may seed from, but nothing on
 *                      it has been certified yet. In-lane, unproven.
 *   0 · `none`       — nothing ties it to the archive. Captured last, or not at all.
 *
 * ── WHY THE VETO IS NOT OPTIONAL, AND WHY IT IS NOT A CRAWL-SCOPE VIOLATION ─────────────
 * Every one of the operator's 8 DISABLED labels — Anjunabeats, Armada, Axtone, Positiva … —
 * CARRIES A FINDING: each arrived on a single crossover remix. So without the veto, "its
 * label already carries a finding" fires on all of them, and the capture queue would spend
 * a metered, per-GB audio budget buying trance and house records the operator has explicitly
 * said are not his lane. That is not a hypothetical; it was caught ranking real archive data.
 *
 * And it does NOT breach the crawl-scope-never-storage rule (docs/label-entity.md). A ruling
 * governs what Fluncle ACQUIRES next, and a capture IS an acquisition — the same class of act
 * as a crawl, just further down the same pipe. Nothing stored moves: the track keeps its row,
 * keeps appearing in the capture lens, and keeps its honest reason line ("not our lane"). It
 * is ordered last, not deleted, hidden, or changed.
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

  for (const artist of candidate.artists) {
    if (archive.findingArtists.has(artist.trim().toLowerCase())) {
      return { priority: CAPTURE_TIER.artist, reason: { kind: "artist", name: artist } };
    }
  }

  if (slug && candidate.label) {
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
 */
export function rankCorpus(findings: number, embeddedFindings: number): string {
  return `${findings}:${embeddedFindings}`;
}

// ── The sweep ────────────────────────────────────────────────────────────────────────

/** One tick's outcome — the JSON summary line a `--no-agent` cron prints. */
export type RankCatalogueSummary = {
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
  /** Catalogue rows still carrying a stale/absent fingerprint after this tick. */
  remaining: number;
  /** Catalogue rows given a `nearest_finding_score` (they have a vector). */
  scored: number;
};

/** The default candidates per tick. `batch × findings` bounds the tick's cosine work. */
export const RANK_BATCH_SIZE = 250;

type CandidateRow = {
  artists_json: string;
  capture_status: string | null;
  has_vector: number;
  isrc: string | null;
  label: string | null;
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
  candidate: { artists_json: string; isrc: null | string; label: null | string },
  archive: ArchiveAffinity,
  findingIsrcs: Map<string, string>,
): { duplicateOf: null | string; priority: number } {
  const dupKey = normalizeIsrc(candidate.isrc);
  const duplicateOf = dupKey ? (findingIsrcs.get(dupKey) ?? null) : null;
  const priority = duplicateOf
    ? DUPLICATE_CAPTURE_TIER
    : capturePriorityFor(
        { artists: parseArtistsJson(candidate.artists_json), label: candidate.label },
        archive,
      ).priority;

  return { duplicateOf, priority };
}

/**
 * Read the archive's affinity sets. Bounded by the FINDING count (tens of rows today,
 * thousands at worst) — never by the catalogue, which is the table that grows.
 */
async function readArchiveAffinity(): Promise<ArchiveAffinity> {
  const db = await getDb();
  const [artistResult, labelResult, seedResult] = await Promise.all([
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

  return { disabledLabels, findingArtists, findingLabels, seedLabels };
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
export async function rankCatalogue(limit = RANK_BATCH_SIZE): Promise<RankCatalogueSummary> {
  const db = await getDb();
  const countResult = await db.execute({
    args: [],
    sql: `select
            (select count(*) from findings) as findings,
            (select count(*) from findings join tracks ft on ft.track_id = findings.track_id
             where ${embeddingVectorSql("ft")} is not null) as embedded`,
  });
  const counts = typedRows<{ embedded: number; findings: number }>(countResult.rows)[0];
  const findings = Number(counts?.findings ?? 0);
  const embeddedFindings = Number(counts?.embedded ?? 0);
  const corpus = rankCorpus(findings, embeddedFindings);

  // The stale catalogue rows: fingerprint drift (the corpus moved) OR a vector that arrived
  // after the row was last ranked (it still carries a NON-NEGATIVE pre-audio tier the scoring
  // path always clears — see the rankCorpus doc). The `capture_priority >= 0` clause is what
  // lets the scoring path DELIBERATELY stamp a vectored row with a negative tier (a −2 true
  // duplicate, docs/the-ear.md § Wrong audio) without that stamp reading as "ranked before its
  // vector arrived" — a negative tier is a decision, not a leftover, so it is not re-picked.
  // `has_vector` evaluates the read contract (blob first, guarded JSON fallback) as a BOOLEAN in
  // SQL — no vector ever crosses the wire.
  const candidateResult = await db.execute({
    args: [corpus, Math.max(0, limit)],
    sql: `select ct.track_id as track_id,
                 ct.title as title,
                 ct.artists_json as artists_json,
                 ct.label as label,
                 ct.isrc as isrc,
                 ct.capture_status as capture_status,
                 (${embeddingVectorSql("ct")} is not null) as has_vector
          from tracks ct
          left join findings cf on cf.track_id = ct.track_id
          where cf.track_id is null
            and (ct.catalogue_rank_corpus is null
                 or ct.catalogue_rank_corpus <> ?
                 or (${embeddingVectorSql("ct")} is not null
                     and ct.capture_priority is not null
                     and ct.capture_priority >= 0))
          order by ct.track_id asc
          limit ?`,
  });
  const candidates = typedRows<CandidateRow>(candidateResult.rows);

  if (candidates.length === 0) {
    // `remaining` is COUNTED, never assumed to be zero. An empty batch normally does mean a
    // drained catalogue — but not if `limit` was 0, and a cron that trusts an assumed 0 would
    // stop calling while rows were still stale. The count is one cheap scoped COUNT, paid only
    // on an already-idle tick.
    return {
      corpus,
      embeddedFindings,
      findings,
      prioritized: 0,
      quarantined: 0,
      remaining: await countStale(corpus),
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
  const winners = new Map<string, WinnerRow>();

  if (vectored.length > 0 && embeddedFindings > 0) {
    const ids = vectored.map((row) => row.track_id);
    const placeholders = ids.map(() => "?").join(", ");
    const rankedResult = await db.execute({
      args: ids,
      sql: `with finding_vec as (
              select ft.track_id as fid, ${embeddingVectorSql("ft")} as fvec
              from findings
              join tracks ft on ft.track_id = findings.track_id
            ),
            candidate_vec as (
              select ct.track_id as cid, ${embeddingVectorSql("ct")} as cvec
              from tracks ct
              where ct.track_id in (${placeholders})
            ),
            pair as (
              select candidate_vec.cid as cid,
                     finding_vec.fid as fid,
                     vector_distance_cos(candidate_vec.cvec, finding_vec.fvec) as dist
              from candidate_vec
              join finding_vec
              where candidate_vec.cvec is not null and finding_vec.fvec is not null
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
  // title+artist identity map is needed only to ADJUDICATE a near-1.0 vectored row — the common
  // tick has none, so all three finding-bounded reads stay off the hot path until a row earns them.
  const nearWrongAudio = vectored.filter((row) => {
    const winner = winners.get(row.track_id);

    return (
      row.capture_status !== QUARANTINE_CLEARED &&
      winner !== undefined &&
      1 - Number(winner.dist) >= WRONG_AUDIO_QUARANTINE
    );
  });
  const needsPreAudio = unvectored.length > 0 || nearWrongAudio.length > 0;
  const [archive, findingIsrcs, findingIdentities] = await Promise.all([
    needsPreAudio ? readArchiveAffinity() : undefined,
    needsPreAudio ? readFindingIsrcs() : undefined,
    nearWrongAudio.length > 0 ? readFindingIdentities() : undefined,
  ]);

  // ── The scored half, now with the wrong-audio veto (docs/the-ear.md § Wrong audio) ──
  let quarantined = 0;

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

      if (findingKey !== undefined && findingKey === rowKey) {
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

      // DIFFERENT TITLE → WRONG AUDIO. The capture matched the artist's already-logged hit, so
      // this vector is a lie about what the row is. QUARANTINE: drop the poisoned vector + score
      // (a catalogue row is never anyone's nearest-finding candidate, so nulling it poisons no
      // other ranking), remember the collided finding as the WHY, and re-derive the pre-audio
      // tier so it re-enters the capture queue for a fresh download. `source_audio_key` is KEPT
      // on the row: its embedded sha256 is the memory the capture sweep uses to refuse an
      // identical re-download (docs/the-ear.md § Wrong audio). `capture_status = 'wrong-audio'`
      // is the re-capture trigger AND the embed/analyze guard (track-work.ts).
      const preAudio = archive
        ? preAudioPriority(candidate, archive, findingIsrcs ?? new Map<string, string>())
        : { duplicateOf: null, priority: 0 };
      quarantined += 1;
      writes.push({
        args: [
          WRONG_AUDIO_STATUS,
          winner.fid,
          preAudio.priority,
          preAudio.duplicateOf,
          corpus,
          now,
          candidate.track_id,
        ],
        sql: `update tracks
              set capture_status = ?,
                  embedding_json = null,
                  embedding_blob = null,
                  nearest_finding_score = null,
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
      // THE DUPLICATE CHECK, before the ladder. An exact ISRC match to a certified finding means
      // buying this row's audio buys something already on file — the money the crawler's real
      // "Infinity" duplicate would have spent. It is the −2 veto tier (excluded by the capture
      // queue's `capture_priority >= 0` predicate, no new mechanism), and the finding it matched
      // is stored so the board can name it. NULL clears a stale marker when the finding is gone.
      const { duplicateOf, priority } = preAudioPriority(
        candidate,
        archive,
        findingIsrcs ?? new Map<string, string>(),
      );

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

  // One implicit write transaction. Every statement is PK-keyed and idempotent, so a retry
  // after a partial failure converges on the same rows.
  await db.batch(writes, "write");

  return {
    corpus,
    embeddedFindings,
    findings,
    prioritized: unvectored.length,
    quarantined,
    remaining: await countStale(corpus),
    // A quarantined row was scored, then vetoed — it is no longer a `scored` find.
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
          left join findings cf on cf.track_id = ct.track_id
          where cf.track_id is null
            and (ct.catalogue_rank_corpus is null
                 or ct.catalogue_rank_corpus <> ?
                 or (${embeddingVectorSql("ct")} is not null
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
 */
export type CatalogueLens = "capture" | "ear" | "quarantine";

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
  artists: string[];
  bpm: number | null;
  capturePriority: number | null;
  captureReason: CapturePriorityReason | null;
  /**
   * The certified finding this row is the SAME RECORDING as — hydrated, so the board can name
   * it ("already in the archive"). Two paths set it (docs/the-ear.md § Duplicates): the CAPTURE
   * lens from the stored `duplicate_of_track_id` (a pre-audio ISRC match), the EAR lens from
   * `nearestFinding` when the score is ≥ `DUPLICATE_SIMILARITY` (a scored near-1.0 match). Null
   * on an ordinary catalogue row — the common case, an actual discovery.
   */
  duplicateOf: CatalogueMatch | null;
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
   * Catalogue rows QUARANTINED as wrong audio (docs/the-ear.md § Wrong audio) — awaiting a
   * fresh capture, held in their own lens rather than mixed into the capture queue.
   */
  quarantined: number;
  /** Catalogue rows carrying a `nearest_finding_score` — what The Ear can actually hear. */
  ranked: number;
  /** Every `tracks` row with no `findings` row. */
  total: number;
};

/** The catalogue's whole shape in one read — four scoped counts, no scan of the rows. */
export async function getCatalogueSummary(): Promise<CatalogueSummary> {
  const db = await getDb();
  const result = await db.execute({
    args: [WRONG_AUDIO_STATUS, WRONG_AUDIO_STATUS],
    sql: `select
            count(*) as total,
            sum(case when ct.nearest_finding_score is not null then 1 else 0 end) as ranked,
            sum(case when ct.nearest_finding_score is null
                      and ct.capture_priority is not null
                      and ct.capture_status <> ? then 1 else 0 end) as awaiting_capture,
            sum(case when ct.capture_status = ? then 1 else 0 end) as quarantined,
            sum(case when ct.catalogue_rank_corpus is null then 1 else 0 end) as awaiting_rank
          from tracks ct
          left join findings cf on cf.track_id = ct.track_id
          where cf.track_id is null`,
  });
  const row = typedRows<{
    awaiting_capture: number | null;
    awaiting_rank: number | null;
    quarantined: number | null;
    ranked: number | null;
    total: number | null;
  }>(result.rows)[0];

  return {
    awaitingCapture: Number(row?.awaiting_capture ?? 0),
    awaitingRank: Number(row?.awaiting_rank ?? 0),
    quarantined: Number(row?.quarantined ?? 0),
    ranked: Number(row?.ranked ?? 0),
    total: Number(row?.total ?? 0),
  };
}

type CatalogueRow = {
  album_image_url: string | null;
  artists_json: string;
  bpm: number | null;
  capture_priority: number | null;
  catalogue_ranked_at: string | null;
  duplicate_of_track_id: string | null;
  key: string | null;
  label: string | null;
  nearest_finding_score: number | null;
  nearest_finding_track_id: string | null;
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
  ct.bpm, ct.key, ct.label, ct.release_date, ct.nearest_finding_score, ct.nearest_finding_track_id,
  ct.capture_priority, ct.catalogue_ranked_at, ct.duplicate_of_track_id`;

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
  const db = await getDb();
  const query =
    lens === "ear"
      ? {
          args: [page],
          sql: `select ${CATALOGUE_SELECT}
                from tracks ct
                left join findings cf on cf.track_id = ct.track_id
                where cf.track_id is null and ct.nearest_finding_score is not null
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
                  where cf.track_id is null and ct.capture_status = ?
                  order by ct.catalogue_ranked_at desc, ct.track_id asc
                  limit ?`,
          }
        : {
            // The capture queue EXCLUDES the quarantined rows — they are a re-capture, held in
            // their own lens, not part of the cold pre-audio queue.
            args: [WRONG_AUDIO_STATUS, page],
            sql: `select ${CATALOGUE_SELECT}
                  from tracks ct
                  left join findings cf on cf.track_id = ct.track_id
                  where cf.track_id is null
                    and ct.nearest_finding_score is null
                    and ct.capture_priority is not null
                    and ct.capture_status <> ?
                  order by ct.capture_priority desc, ct.track_id asc
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
  const archive = lens === "capture" ? await readArchiveAffinity() : undefined;

  return rows.map((row) => {
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
      artists,
      bpm: row.bpm,
      capturePriority: row.capture_priority,
      captureReason: archive
        ? capturePriorityFor({ artists, label: row.label }, archive).reason
        : null,
      duplicateOf,
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
}
