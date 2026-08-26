// THE AUDIO PIPELINE'S WORK QUEUES — capture → analyze → embed, over `tracks`.
//
// ── WHY THIS MODULE EXISTS (the bug it fixes) ────────────────────────────────────────
// Before the catalogue split every track WAS a finding, so the three sweeps read their
// worklists off `listTracks` — the FEED engine, which drives through `FINDINGS_FROM`, an
// INNER JOIN onto the certification. Post-split that join is a silent filter: a catalogue
// track (a `tracks` row with NO `findings` row) is structurally invisible to it. The
// capture, analyze, and embed sweeps therefore could not SEE a catalogue track at all —
// so it could never be captured, never analysed, never embedded, and so The Ear
// (docs/the-ear.md), which ranks by embedding similarity, would have had nothing to rank.
//
// The fix is not a wider join on the feed. It is the recognition that these three queues
// were never finding queues in the first place: BPM, key, features, the MuQ vector, and
// the captured audio all live on `tracks` (they are true of the RECORDING), so their
// worklists belong on `tracks` too. The feed engine keeps its inner join — that is the
// safety property of the split — and the work queues get their own read, here.
//
// ── WHAT STAYS FINDINGS-ONLY, AND WHY THAT IS NOT NEGOTIABLE ─────────────────────────
// Analysis and embedding are MEASUREMENTS of audio. They are true of any recording,
// certified or not, and they say nothing. Everything Fluncle SAYS — the context note, the
// auto-note, the spoken observation, the video, the publish push — is a CERTIFICATION
// concern and stays behind `findings`. Fluncle does not speak about a track he has not
// been to (ratified canon). That rail is enforced one layer down, in `updateTrack`
// (track-update.ts): an uncertified track accepts the `tracks`-column analysis fields and
// REJECTS every `findings` column, so no sweep can accidentally certify one from here.
//
// ── THE ORDER IS THE BUDGET (docs/the-ear.md) ────────────────────────────────────────
// Audio capture is METERED — a residential proxy bills per GB — so the order in which
// this queue drains literally decides what the money buys. It is one ORDER BY, in SQL:
//
//   1. CERTIFIED FIRST. A finding is a track Fluncle already said yes to; its analysis
//      backlog outranks any speculative catalogue row. The catalogue can never starve it.
//   2. Then `capture_priority` DESC — the Ear's pre-audio ladder (artist > label >
//      seed-label > nothing; a ruled-out label is vetoed). Every finding ties at 0 here,
//      so the rung only ever orders the catalogue.
//   3. Then `demand_score` DESC — the DEMAND signal (docs/catalogue-crawler.md § Demand): the
//      pageviews of the artists/labels real visitors looked at, a WITHIN-TIER reorder written by
//      `record_demand`. It sits below the ladder, so it only ever breaks a tie — it never lifts
//      a row across a tier and never past the veto (the `>= 0` exclusion runs first, in
//      `kindClause`). A finding ties at 0 here too, so it never reorders the findings.
//   4. Then newest-first within the findings (today's behaviour), and the track id as a
//      deterministic tiebreak so a tick is reproducible.
//
// Never alphabetical, never insertion order.
//
// ── THE VETO IS A PREDICATE, NOT A SORT ──────────────────────────────────────────────
// A label the operator ruled out is tier −1 (catalogue.ts), which is what lets the CAPTURE
// queue exclude it in SQL — `capture_priority >= 0`. Sorting it last would not do: the
// queue drains, and "last" eventually arrives. A veto that only reorders is not a veto.
//
// It is scoped to the two METERED queues, deliberately: CAPTURE and ANCHOR. A ruling governs
// what Fluncle SPENDS ON (docs/label-entity.md — a capture is an acquisition, and an anchor
// offer is a billed Apify search), not what he may measure. If the bytes are already bought,
// analysing and embedding them is free, and a vector is how the Ear gets to disagree with the
// ladder. So `analyze`/`embed` carry no veto — the vetoed row simply sorts last there, exactly
// as the-ear.md says. The two spellings differ because the columns do; see
// `ANCHOR_RULED_OUT_LABEL_CLAUSE` for why the anchor reads the ruling itself rather than the
// ladder's `capture_priority >= 0` mirror of it.
//
// ── AND THE ORDER IS NOT THE WHOLE BUDGET (./capture-budget.ts) ──────────────────────
// The ladder above decides WHAT the metered GB buy. It has nothing to say about HOW MUCH,
// and at catalogue scale that is the gap that costs money: the crawler writes uncertified
// rows by the thousand and this queue drains whatever it is given (4 a tick × 288 ticks ≈
// 1,150 songs ≈ ~9 GB of proxy traffic a day, forever). So the capture worklist consults
// the CAPTURE BUDGET — a kill switch plus a rolling-24h count/byte cap on the `settings`
// KV — and NARROWS ITSELF TO THE FINDINGS when that budget is shut.
//
// THE BRAKE LIVES HERE, at the queue, and not in the sweep that downloads. That is the
// whole design decision. This function is the ONLY door a catalogue row can reach a metered
// download through (`list_tracks_admin`'s queue filters drive through the FINDING JOIN and
// are structurally blind to a catalogue row — see the header above), so a brake here binds
// EVERY client: the box sweep, the CLI, a future sweep nobody has written. A brake in the
// box script would be re-bakeable, bypassable, and one `curl` away from irrelevant.
//
// It narrows, it never empties: `scope: "all"` with a shut budget returns the FINDINGS, in
// their usual order. A certified finding's capture is a handful a week, it is not the spend,
// and the archive is never starved by the speculative half.

import { anchorSearchQuery } from "./anchor";
import { deezerSearchQuery } from "./deezer";
import { type CatalogueCaptureState, isCatalogueCaptureOpen } from "./capture-budget";
import { LONG_FORM_MS, MIN_TRACK_MS } from "./catalogue";
import { parseArtistsJson } from "./artists";
import { getDb, typedRows } from "./db";
import {
  countTrackWorkDue,
  isTrackWorkDueCutoverEnabled,
  readTrackWorkDueIds,
} from "./due-work-cutover";
import { type DueWorkClient } from "./due-work";
import {
  CAPTURE_FAILED_COOLDOWN_MS,
  CAPTURE_MAX_FAILURES,
  readArtistYoutubeChannelIdsByTrack,
} from "./tracks";

/**
 * Which stage of the audio pipeline a worklist is for. The three are strictly sequential
 * for any one track — capture puts the bytes in private R2, analyze reads them for
 * BPM/key/features, embed reads them for the MuQ vector — but they are INDEPENDENT
 * queues: capture never gates the other two (docs/track-lifecycle.md), and analyze never
 * gates embed.
 */
export type TrackWorkKind =
  | "analyze"
  | "anchor"
  | "capture"
  | "embed"
  | "isrc-recovery"
  | "youtube-provenance"
  | "youtube-reverdict";

/** The free Deezer pass shares the MusicBrainz ISRC refresh's three-week re-ask cadence. */
export const ISRC_RECOVERY_REASK_AFTER_DAYS = 21;

/**
 * THE PROVENANCE RE-ASK WINDOW. How long a captured row whose YouTube provenance came back
 * EMPTY-HANDED sits out before the backfill offers it again.
 *
 * Every offer is a full candidate download through the metered proxy, so this is the same shape as
 * the anchor's re-ask window and for the same reason: "nothing on YouTube fingerprint-matches this
 * today" is not "nothing ever will" — uploads appear — but a row re-asked every five minutes is a
 * treadmill that bills forever for an answer that is not changing. A quarter is long enough that a
 * genuinely absent upload has had time to appear, and short enough that the archive keeps closing.
 * The stamp it reads is `youtube_verified_at`, written by the sweep's `no-match` report.
 */
export const YOUTUBE_PROVENANCE_REASK_AFTER_DAYS = 90;

/**
 * THE PROVENANCE CAN'T-CONCLUDE CAP. How many runs that SETTLED NOTHING a row may accumulate before
 * the backfill stops offering it at all.
 *
 * The window above paces a row that concluded honestly; this retires the one that never concludes.
 * Both empty-handed reports move the streak — `no-match` (every rung ran and nothing on YouTube is
 * vouchable) and `inconclusive` (the CDN refused every section the ladder tried, so there was no
 * answer to have) — and the second is the one that would otherwise loop: it writes no stamp by
 * design, so without a cap the same refused row returns on the very next tick, forever, starving
 * everything behind it.
 *
 * FIVE rather than the anchor's three. A `no-match` run costs a quarter each time, so five spans
 * more than a year of genuine re-asking; and an `inconclusive` run is a CDN mood rather than a fact
 * about the recording, which deserves more than three chances to pass. A retired row is not a ruled
 * row: nothing is written to its receipt, the identity envelope never reads this column, and a
 * later full capture still fills the id for free.
 */
export const YOUTUBE_PROVENANCE_MAX_FAILURES = 5;

/**
 * THE ANCHOR RE-ASK BACKOFF (docs/catalogue-crawler.md § the anchor). How long a catalogue row
 * that was ATTEMPTED and missed sits out before the anchor worklist offers it again. "Not on
 * Spotify today" is NOT "never on Spotify" — a small-label recording lands on Spotify weeks after
 * its MusicBrainz release — so a missed row must be re-asked; but every re-ask is a billed Apify
 * search (~$0.015/row), so it is re-asked on a WINDOW, not every tick. 14 days is the ratified
 * balance: a row genuinely absent today gets a fresh look a fortnight later, at a bounded spend.
 */
export const ANCHOR_REASK_AFTER_DAYS = 14;

/**
 * THE ANCHOR RETRY CAP — how many FULL attempts a catalogue row gets before the worklist stops
 * offering it (`tracks.spotify_anchor_attempts`, incremented in the same UPDATE as the stamp).
 *
 * The backoff window above bounds the RATE of the spend; this bounds its TOTAL. Without a cap the
 * window is a treadmill: a recording genuinely absent from Spotify — a white label, a dubplate, a
 * digital-only release the DSPs never got — is re-asked every fortnight forever, so its lifetime cost
 * is unbounded while its odds of ever anchoring only fall. Six attempts at the 14-day cadence is
 * ~3 months of looking, which is long enough for the case the window exists for (a small-label
 * recording lands on Spotify weeks after its MusicBrainz release), and after that the row is left to
 * REST — never deleted, never marked failed, just no longer bought. A row that does appear later is
 * still recoverable: the counter is a queue gate, not a verdict, and the operator can zero it.
 */
export const ANCHOR_MAX_ATTEMPTS = 6;

/**
 * THE UNANCHORABLE ARTIST CREDITS — names that are not an identity, so no search can ever anchor a
 * row billed to them. A crawled release with no artist credit arrives as `Unknown Artist` /
 * `Various Artists` / a `[unknown]` placeholder, and the anchor gate's verified triple needs a real
 * artist to match on: such a row misses every rung, gets stamped, and comes back a fortnight later to
 * miss again. It is unanchorable BY CONSTRUCTION, so it never belongs in the queue at all — the cap
 * would eventually retire it, but only after six billed searches that could not have succeeded.
 *
 * Matched against the WHOLE `artists_json` string, which is why this is a set of exact JSON literals
 * rather than a name list: `artists_json` is always `JSON.stringify(string[])`, so the SOLE-credit
 * case is one canonical string per name and a plain `lower(artists_json) not in (…)` answers it with
 * bound params and no per-row work. A MULTI-artist credit that merely CONTAINS one of these names
 * ( `["Unknown Artist","Calibre"]` ) carries a real name too and stays IN the queue — deliberately,
 * and the reason this is not a `like`/`json_each` test: `json_each` executes per row on hosted Turso
 * (the ratified trap), and the hot worklist read cannot afford it.
 */
const UNANCHORABLE_ARTIST_CREDITS = [
  "Unknown Artist",
  "Various Artists",
  "VA",
  "Unknown",
  "[unknown]",
  "traditional",
];

/**
 * The `artists_json` literals for {@link UNANCHORABLE_ARTIST_CREDITS}, lower-cased for the SQL
 * `lower(artists_json) not in (…)` compare and built with the same `JSON.stringify` the write paths
 * use, so the strings match byte-for-byte by construction rather than by hand-transcription.
 */
const UNANCHORABLE_ARTISTS_JSON = UNANCHORABLE_ARTIST_CREDITS.map((name) =>
  JSON.stringify([name]).toLowerCase(),
);

/**
 * Which half of the archive a worklist covers.
 *
 *   - `findings`  — certified tracks only (a `findings` row exists).
 *   - `catalogue` — uncertified tracks only (no `findings` row). The Ear's raw material.
 *   - `all`       — both, certified first. The default: the pipeline does not care whether
 *                   a recording is certified, only whether it has audio to measure.
 */
export type TrackWorkScope = "all" | "catalogue" | "findings";

/**
 * One row of work. It carries the track's identity and the facts a sweep needs to act — the
 * captured-audio key, whether the track is certified, and (for the `capture` worklist only)
 * the trust + re-derive signals the download step reads.
 *
 * `certified` is on the DTO on purpose: it is what tells a sweep it must NOT write a
 * certification field (a `--status`, a note, a video, an `enrichment_status`) on this row.
 * `logId` is null exactly when `certified` is false, because the coordinate lives on the
 * certification.
 *
 * The four `capture`-only fields (`bpm`, `analyzedFrom`, `sourceAudioFailures`,
 * `artistYoutubeChannelIds`) are what the finding-only capture queue (`captureQueue=true`,
 * tracks.ts) surfaced before this worklist replaced it — carried here so the migrated sweep's
 * per-finding behaviour (trust classification, failure-count accumulation, the capture→enrich
 * re-derive) is byte-identical to the migrated worklist. They are ABSENT for
 * `analyze`/`embed`, which read those columns off the row directly and never needed them here.
 */
export type TrackWorkItem = {
  /**
   * Which audio class BPM/key were last analyzed from — CAPTURE-only, so the sweep can
   * decide whether a newly captured track must re-derive from the full song. Absent for
   * `analyze`/`embed` (they read it off the row directly) and for a never-analyzed track.
   */
  analyzedFrom?: "full" | "preview";
  /**
   * The ready-made Spotify search query for the ANCHOR worklist (`anchorSearchQuery`: the row's
   * artists then its title) — so the box's Apify sweep stays dumb and never has to know how to
   * build the query. Attached ONLY for the `anchor` worklist; absent for every other kind.
   */
  anchorQuery?: string;
  /**
   * The artist's own YouTube channel id(s) — CAPTURE-only, the sweep's strongest download
   * trust signal (a candidate on the artist's OWN channel is the artist's upload). Attached
   * only for the `capture` worklist, and only when non-empty (never surfaced as `[]`).
   */
  artistYoutubeChannelIds?: string[];
  artists: string[];
  /**
   * The stored BPM — CAPTURE-only, read alongside `analyzedFrom` for the re-derive predicate.
   * Absent for other kinds and when genuinely missing (null/≤0).
   */
  bpm?: number;
  /** The Ear's pre-audio ladder tier, or null on a finding / an unranked catalogue row. */
  capturePriority: number | null;
  /** True when a `findings` row exists — the certification rail's flag, in the DTO. */
  certified: boolean;
  /**
   * The ready-made DEEZER search query (`deezerSearchQuery`: Deezer's `artist:"…" track:"…"` field
   * syntax over the row's first artist + its canonicalized title) — a DIFFERENT spelling from
   * `anchorQuery`, which is the free-text ask the Spotify rungs use. Attached for every
   * ISRC-RECOVERY row and for an ANCHOR row that carries NO ISRC, because those are exactly the rows
   * the pre-anchor recovery rung acts on; its presence is the server telling the box "search Deezer
   * for this one, from your own IP". Absent for other kinds, for an anchor row that already has an
   * ISRC, and when the row has no usable artist/title to ask with.
   */
  deezerQuery?: string;
  durationMs: number;
  isrc: null | string;
  label: null | string;
  /** Null for every catalogue track: the coordinate lives on `findings`. */
  logId: null | string;
  /**
   * The consecutive full-song capture failures — CAPTURE-only, read so the sweep's failure
   * bump ACCUMULATES (the queue's failure-cap backoff depends on it). Absent for other kinds
   * and when zero, matching the finding-only capture DTO's convention.
   */
  sourceAudioFailures?: number;
  /** The private-R2 key of the captured full song. Presence = there is audio to work on. */
  sourceAudioKey: null | string;
  /**
   * The bad-audio memory (docs/the-ear.md § Wrong audio) — the JSON array of rejected capture
   * sources ({ videoId?, sha256, reason, at }). CAPTURE-only like the trust signals: the sweep's
   * pre-download videoId filter + post-download sha backstop read it. Absent when empty.
   */
  sourceAudioRejected?: string;
  title: string;
  trackId: string;
};

type WorkRow = {
  analyzed_from: null | string;
  artists_json: string;
  bpm: null | number;
  capture_priority: null | number;
  certified: number;
  duration_ms: number;
  isrc: null | string;
  label: null | string;
  log_id: null | string;
  source_audio_failures: null | number;
  source_audio_key: null | string;
  source_audio_rejected: null | string;
  title: string;
  track_id: string;
};

const WORK_SELECT = `t.track_id, t.title, t.artists_json, t.isrc, t.label, t.duration_ms,
  t.source_audio_key, t.source_audio_rejected, t.capture_priority, t.bpm, t.analyzed_from, t.source_audio_failures,
  f.log_id as log_id,
  (f.track_id is not null) as certified`;

/**
 * THE ORDER INSIDE ONE CERTIFICATION HALF. The leading certification term is deliberately absent:
 * {@link listTrackWork} reads findings and catalogue separately, then concatenates them in that
 * order. That is exactly `(f.track_id is not null) desc`, but it lets the catalogue read seek the
 * `tracks_catalogue_capture_idx` ladder instead of sorting the whole growing table on a joined
 * expression.
 *
 * `coalesce(t.capture_priority, 0)` remains load-bearing wherever the kind permits NULL: it makes a
 * NULL tie with tier 0 and keeps both ahead of a negative tier. CAPTURE is the one proved exception
 * on the catalogue half — `kindClause("capture")` requires `capture_priority is not null` there, so
 * the plain column is byte-for-byte the same order and can ride the index.
 *
 * `coalesce(t.demand_score, 0)` is the DEMAND reorder (docs/catalogue-crawler.md § Demand), and its
 * POSITION is the whole contract: it sits AFTER `capture_priority`, so it only ever reorders rows
 * of the SAME tier — a demanded row is captured before an undemanded sibling at its tier, never
 * lifted across the ladder, and NEVER past the `capture_priority >= 0` veto. No kind predicate
 * excludes a NULL demand score, so that coalesce stays. The added-at expression stays for the same
 * reason; these deep tie-breaks may still need a TEMP B-TREE, but only after the indexed half seek.
 */
function workOrder(kind: TrackWorkKind, half: Exclude<TrackWorkScope, "all">): string {
  const capturePriority =
    kind === "capture" && half === "catalogue"
      ? "t.capture_priority"
      : "coalesce(t.capture_priority, 0)";

  return `order by ${capturePriority} desc,
  coalesce(t.demand_score, 0) desc,
  coalesce(f.added_at, '') desc,
  t.track_id desc`;
}

/**
 * THE ANCHOR ORDER — the same "the order IS the budget" law as the capture ladder, for the
 * metered Apify anchor spend (docs/catalogue-crawler.md § the anchor). The anchor worklist is
 * catalogue-only (a finding's Spotify id is its identity), so there is no certified/findings
 * split here; the drain order is:
 *   1. ISRC-BEARING rows first (`has_isrc`) — anchorability before sunk cost. In practice a
 *      billed search concludes almost exclusively through the exact-ISRC rung, so an ISRC-less
 *      row at the head is money spent on an ask that cannot conclude while an answerable row
 *      waits behind it.
 *   2. Then EMBEDDED rows (`has_embedding`) — a row Fluncle has already spent capture + embed
 *      money on is one he most wants recommendable, so anchor it next.
 *   3. Then `nearest_finding_score DESC` — the Ear's best un-anchored candidates, the ones
 *      closest to his taste, ahead of the unranked tail.
 *   4. Then `track_id` — a deterministic tiebreak so a batch is reproducible.
 *
 * Every ordering column is read IN SQL (never selected into the isolate), and the whole clause is
 * ONE REVERSE WALK of `tracks_anchor_order_idx` — the plain-ASC `(has_isrc, has_embedding,
 * nearest_finding_score, track_id) where spotify_uri is null` partial index (schema.ts), whose
 * predicate is the same literal clause `kindClause("anchor")` carries. Three spellings here are
 * load-bearing:
 *
 *   · `t.has_isrc` / `t.has_embedding`, not the raw facts they stand for (`isrc is not null and
 *     trim(isrc) <> ''` / a `track_embeddings` row exists). A btree cannot key on an expression
 *     or on another table, so either spelling would force the sweep to materialise the whole
 *     un-anchored set, table-probe each row and sort — hourly, over a set that grows with the
 *     catalogue. Each mirror is written in the same statement (or the same write BATCH) as every
 *     write of what it mirrors (schema.ts § `has_embedding`, § `has_isrc`), so this reads the
 *     truth rather than a copy of it.
 *   · no `nulls last`. SQLite sorts NULL smallest, so a plain `desc` ALREADY puts the unranked
 *     tail last — the two spellings are exactly equivalent, and the plain one gives the planner
 *     nothing extra to reason about when matching the clause to the index.
 *   · `track_id desc`, not `asc`. A mixed `desc, …, asc` cannot ride the composite as one
 *     reverse walk and forces a temp B-tree over the entire un-anchored set. The tiebreak exists
 *     only for a deterministic order among otherwise-equal rows and its direction is arbitrary —
 *     nothing depends on it (there is no keyset pagination on this read, just LIMIT) — so it goes
 *     `desc`. Same law as the `/admin/catalogue` capture lens (catalogue.ts).
 */
const ANCHOR_ORDER = `order by t.has_isrc desc,
  t.has_embedding desc,
  t.nearest_finding_score desc,
  t.track_id desc`;

/**
 * THE RE-VERDICT ORDER — oldest-ruled first, which is what makes the queue a self-draining
 * round-robin rather than a set that needs a "which rule version judged this" column.
 *
 * SQLite sorts NULL smallest, so a plain `asc` already puts the NEVER-RULED rows (an oEmbed that
 * timed out at capture time) ahead of everything that has at least an old answer — exactly the
 * priority wanted, and spelled without a `nulls first` the planner would have to reason about.
 * `track_id` is the deterministic tiebreak so a tick is reproducible.
 */
const REVERDICT_ORDER = `order by t.youtube_verified_at asc, t.track_id asc`;

/** The scope's WHERE fragment. Static literals — never interpolated user input. */
export function scopeClause(scope: TrackWorkScope): string {
  if (scope === "findings") {
    return "f.track_id is not null";
  }

  if (scope === "catalogue") {
    return "f.track_id is null";
  }

  return "1 = 1";
}

/**
 * One physical half of the shared work order. The findings predicate preserves the canonical
 * membership test; the maintained `is_catalogue` mirror gives SQLite the indexed equality it cannot
 * infer through a LEFT JOIN. The schema write paths keep the two equivalent by construction.
 *
 * Catalogue CAPTURE repeats its `kindClause` arm's priority/dismissal constraints at top level. The
 * repetition changes no predicate: under `f.track_id is null`, the other OR arm is impossible. It
 * does expose the complete `(is_catalogue, dismissed_at, capture_priority)` seek to SQLite, which
 * does not simplify those terms out of the nested findings/catalogue OR by itself.
 */
function workHalfClause(kind: TrackWorkKind, half: Exclude<TrackWorkScope, "all">): string {
  const captureSeek =
    kind === "capture" && half === "catalogue"
      ? " and t.dismissed_at is null and t.capture_priority >= 0"
      : "";

  return `${scopeClause(half)} and t.is_catalogue = ${half === "catalogue" ? 1 : 0}${captureSeek}`;
}

/**
 * The kind's WHERE fragment plus its bound args.
 *
 * `capture` — the acquisition worklist: no audio yet, and the capture state machine says
 *   it is still worth trying (`pending`/NULL always; a `wrong-audio` row awaiting re-capture;
 *   a `failed` row only past the cooldown and below the failure cap; a terminal
 *   `done`/`unmatched`/`quarantine-cleared` never re-burned). Then the two halves diverge,
 *   because acquisition needs different things of each:
 *     · a FINDING needs a coordinate — the R2 key is `<logId>/<sha256>.<ext>`, so a
 *       coordinate-less straggler is not capturable.
 *     · a CATALOGUE track needs a RANKED, NON-VETOED tier. `capture_priority is not null`
 *       is the "the Ear has looked at this" gate — capturing an unranked row would be
 *       draining the queue in insertion order, which is the exact failure this queue
 *       exists to prevent. `>= 0` is the veto (see the module header).
 *
 *   `wrong-audio` (docs/the-ear.md § Wrong audio) is a re-capture TRIGGER: The Ear caught a
 *   capture with the wrong master, rewound the row to the pre-audio ladder, and kept its
 *   previous `source_audio_key` so the sweep can refuse the identical bad bytes. Its restored
 *   `capture_priority >= 0` puts it back in line for a fresh download.
 *
 * `analyze` — the full-audio analysis worklist: audio on file, and the stored analysis did
 *   not come from it (`analyzed_from <> 'full'`, or nothing analysed at all). This is
 *   DATA-derived, not status-derived: a catalogue track has no `enrichment_status` (that
 *   column is a certification concern), so the queue reads the columns that actually say
 *   whether the work is done. A `wrong-audio` row is EXCLUDED — its key still points at the bad
 *   bytes, which must not be measured until a fresh capture overwrites them.
 *
 * `embed` — the MuQ worklist: audio on file, no vector. The captured full song is the only
 *   admissible source (a 30s preview yields a garbage vector — ratified), so the key gate
 *   is the point, not a convenience. A `wrong-audio` row is EXCLUDED for the same reason: the
 *   quarantine nulled its vector, but its key still points at the bad bytes — re-embedding them
 *   would just re-poison the ranking. A `quarantine-cleared` row (the operator's override) is
 *   allowed through, so its kept audio re-embeds and re-ranks. A `duplicate-cleared` row (the
 *   force-capture override, docs/the-ear.md § Duplicates) with audio on file passes both guards
 *   too — the forced row must still get its vector, or the exoneration the override exists for
 *   never runs.
 */
/**
 * A machine name for each of the anchor worklist's FIVE PERMANENT exclusions — the reasons a row
 * will never be offered a Spotify search again, as opposed to the temporal re-ask backoff, which is
 * only "not yet". The identity envelope serves one of these as its `refused` reason, so the strings
 * are a wire contract: a closed enum, no tier nouns, and each names the row's own condition rather
 * than the queue's opinion of it.
 */
export type AnchorRefusalReason =
  | "attempt-cap-reached"
  | "credit-not-an-identity"
  | "dismissed"
  | "duplicate"
  | "no-duration";

/**
 * THE FIVE PERMANENT EXCLUSIONS, as ONE reusable SQL fragment — the shared predicate
 * {@link kindClause}'s `anchor` arm and the identity envelope's `refused` state are both derived
 * from, so the two can never drift into saying different things about the same row.
 *
 * It is spelled POSITIVELY (the row is still ELIGIBLE) because that is how the worklist reads it;
 * the envelope negates it, and `anchorRefusalReason` below names WHICH clause failed. Deliberately
 * NOT included: `f.track_id is null` (a scope, not a row property), `t.spotify_uri is null` (the
 * derived worklist itself — a row that HAS a link is `verified`, never `refused`), and the 14-day
 * re-ask backoff (temporal — "not yet" is `absent`, not `refused`; a row under the backoff will be
 * asked again and the envelope must not claim otherwise).
 *
 * Every reference is `t.`-qualified, matching the worklist's `tracks t left join findings f` alias,
 * so a caller must use the same alias.
 */
export function anchorEligibilityClause(): { args: string[]; sql: string } {
  const unanchorable = UNANCHORABLE_ARTISTS_JSON.map(() => "?").join(", ");

  return {
    args: [...UNANCHORABLE_ARTISTS_JSON],
    // The cap is a trusted module int (interpolated); the unanchorable literals are BOUND.
    sql: `t.duration_ms > 0
            and t.dismissed_at is null
            and t.duplicate_of_track_id is null
            and coalesce(t.spotify_anchor_attempts, 0) < ${ANCHOR_MAX_ATTEMPTS}
            and lower(t.artists_json) not in (${unanchorable})`,
  };
}

/** The row shape {@link anchorRefusalReason} reads — the five columns the clause above tests. */
export type AnchorEligibilityRow = {
  artistsJson: null | string;
  dismissedAt: null | string;
  durationMs: null | number;
  duplicateOfTrackId: null | string;
  spotifyAnchorAttempts: null | number;
};

/**
 * The TypeScript twin of {@link anchorEligibilityClause}: `undefined` when the row is eligible,
 * else which permanent exclusion fires. The two are kept in lockstep by a row-for-row integration
 * test (identity-envelope.integration.test.ts) that runs the SQL over a fixture table and asserts
 * the two sets agree exactly — the only way to be sure a wire claim and a worklist agree.
 *
 * ORDER IS THE READING, not a precedence fight: the clauses are independent, and when several fire
 * the first below is served. It leads with the operator's own acts (a dismissal, a duplicate
 * verdict) because those are the answer a reader actually wants, then the structural facts.
 */
export function anchorRefusalReason(row: AnchorEligibilityRow): AnchorRefusalReason | undefined {
  if (row.dismissedAt !== null) {
    return "dismissed";
  }

  if (row.duplicateOfTrackId !== null) {
    return "duplicate";
  }

  if (!(Number(row.durationMs ?? 0) > 0)) {
    return "no-duration";
  }

  if ((row.spotifyAnchorAttempts ?? 0) >= ANCHOR_MAX_ATTEMPTS) {
    return "attempt-cap-reached";
  }

  if (UNANCHORABLE_ARTISTS_JSON.includes((row.artistsJson ?? "").toLowerCase())) {
    return "credit-not-an-identity";
  }

  return undefined;
}

/**
 * THE ANCHOR'S RULED-OUT-LABEL VETO — the capture ladder's tier −1 exclusion, in the one other queue
 * that spends money per row.
 *
 * A label the operator ruled out (`labels.seed_state = 'disabled'`, docs/label-entity.md) is "not our
 * lane": the pre-audio ladder scores its tracks −1 and the CAPTURE queue excludes them in SQL
 * (`t.capture_priority >= 0`, the arm below) rather than sorting them last, because a queue drains and
 * "last" eventually arrives — a veto that only reorders is not a veto. The ANCHOR queue is the other
 * metered queue (every offer is a billed Apify search) and it carried no such filter, so 764 live +
 * 387 benched rows on ruled-out labels sat waiting to be paid for.
 *
 * WHY NOT `capture_priority >= 0` VERBATIM — capture's own spelling. Tier −1 IS this ruling
 * (catalogue.ts `skipped-label`), but that column is an ARTIFACT of the `rank_catalogue` sweep: it
 * carries the whole ladder, and NULL means "the Ear has not looked at this row yet", which is most of
 * the anchor queue. Reusing it would silently gate anchoring on the ranking sweep having run —
 * emptying the queue rather than narrowing it — and it folds the raw `tracks.label` STRING rather
 * than the graph pointer. So this reads the same RULING off its source of truth,
 * `tracks.label_id` → `labels.seed_state`, which needs no sweep to have run and cannot go stale.
 *
 * THE SHAPE IS AN UNCORRELATED `not in`, and that is load-bearing rather than stylistic. This clause
 * does not only run in the worklist: the `/admin/funnel` folded scan interpolates it FOUR TIMES into
 * one conditional-aggregate pass over `tracks` (funnel.ts), a pass whose whole performance story is
 * that it reads out of the covering `tracks_funnel_scan_idx` and never touches a table row.
 *   · A CORRELATED `not exists (… where l.id = t.label_id)` re-executes per arm PER ROW — four
 *     `labels` seeks for every row in the table, forever, and it was measured locally to drop the
 *     funnel's plan from `SCAN … USING COVERING INDEX` to a bare `SCAN t` outright.
 *   · UNCORRELATED, the subquery has no outer reference, so SQLite materialises the ruled-out id set
 *     ONCE per statement into an ephemeral index and every arm probes that in memory. The outer scan
 *     stays covering (`t.label_id` is in the index — see schema.ts, where this clause's columns are
 *     an explicit contract), and the per-row cost is a probe into a few hundred ids.
 * `not in`'s NULL trap does not apply: `labels.id` is the PRIMARY KEY and cannot be NULL, so the
 * subquery can never poison the predicate. An EMPTY set (no ruled-out labels) makes `not in` true and
 * excludes nothing, which is right. A row with no `label_id` short-circuits on the first disjunct and
 * passes, which is also right — an unlinked row is not a ruled-out one.
 *
 * DELIBERATELY NOT IN `anchorEligibilityClause`. That fragment is the identity envelope's `refused`
 * twin and its five members are properties OF THE ROW; a label ruling is a property of the operator's
 * current SCOPE, revocable with one `fluncle admin labels update`. Serving it as a permanent refusal
 * on the wire would state as settled a thing that a ruling can undo tomorrow — the same reasoning
 * that already keeps the catalogue scope and the temporal backoff out of that fragment.
 */
const ANCHOR_RULED_OUT_LABEL_CLAUSE = `(t.label_id is null
              or t.label_id not in (select id from labels where seed_state = 'disabled'))`;

export function kindClause(kind: TrackWorkKind): { args: string[]; sql: string } {
  if (kind === "youtube-provenance") {
    // THE PROVENANCE BACKFILL'S WORKLIST (docs/agents/hermes/scripts/capture-sweep.ts § the
    // provenance phase). Slice #1049 keeps the winning video id at CAPTURE time; every row captured
    // Rows without the winning video id must re-derive it the only honest way: run the ladder
    // again. The id is fill-empty-only and never re-bought once present.
    //
    //   · `source_audio_key is not null` — the row HAS been captured. This queue is a backfill over
    //     history, never a second acquisition path; a row with no audio belongs to `capture`.
    //   · `youtube_video_id is null`     — fill-empty-only, expressed as a queue so a row that has
    //     an id is never re-bought.
    //   · `source_verification is null`  — a banked SoundCloud fingerprint match already proved
    //     the recording, so the same metered search must not be bought again.
    //   · `capture_status <> 'wrong-audio'` — a quarantined row is already queued for a full
    //     re-capture, which will report its own id for free. Spending a second download on it here
    //     buys nothing (same guard, same reason, as `analyze`/`embed`).
    //   · the RE-ASK WINDOW — never asked, or asked longer ago than the window. The sweep's
    //     `no-match` report stamps `youtube_verified_at` precisely so this clause can drain.
    //   · the CAN'T-CONCLUDE CAP — under `YOUTUBE_PROVENANCE_MAX_FAILURES` settled-nothing runs.
    //     The window paces a row that concluded honestly and does nothing at all for one that can
    //     never conclude: a row whose every candidate the CDN refuses reports `inconclusive`, moves
    //     no stamp, and is handed straight back on the next tick — forever, starving everything
    //     queued behind it. The same starvation shape is possible here, and the answer is the same:
    //     the streak counts runs that settled nothing and this clause retires
    //     the row at the cap. Nothing is written to the row's receipt on the way out — the identity
    //     envelope never reads this column, so a retired row honestly reads `Not checked yet`.
    //
    // NO COVERING INDEX, deliberately for now: the shape is the same class as the `capture` and
    // `analyze` predicates beside it (a `tracks` scan with a residual filter), and this queue is
    // read twice a tick at most. An index on it is a schema change worth measuring on hosted Turso
    // first, not one worth guessing at.
    const cutoff = new Date(
      Date.now() - YOUTUBE_PROVENANCE_REASK_AFTER_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    return {
      args: [cutoff],
      sql: `t.source_audio_key is not null
            and t.youtube_video_id is null
            and t.source_verification is null
            and coalesce(t.capture_status, '') <> 'wrong-audio'
            and coalesce(t.youtube_provenance_failures, 0) < ${YOUTUBE_PROVENANCE_MAX_FAILURES}
            and (t.youtube_verified_at is null or t.youtube_verified_at < ?)`,
    };
  }

  if (kind === "youtube-reverdict") {
    // THE RE-VERDICT WORKLIST. Rows that HOLD an id whose officialness is 0 (checked and refused)
    // or NULL (never concluded), re-ruled under whatever the current heuristic is. A row at 1 is
    // excluded: the re-ask exists to say yes more often, never to retract.
    //
    // THERE IS NO WINDOW HERE, and that is the design rather than an omission. The whole point is
    // that a WIDENED rule must reach rows ruled under a narrower one, and a time window cannot
    // express that — a row ruled 0 before the widening would sit out for the whole
    // window while the rule it was judged by no longer exists. Instead the order is OLDEST-RULED
    // FIRST and every re-verdict re-stamps `youtube_verified_at`, which makes the queue a
    // round-robin that fixed-points on its own: each widening drains through the whole 0/NULL set
    // once and then keeps cycling. It can afford to, because the check is a keyless oEmbed read —
    // no quota, no key, no bytes — and the phase spends five of them a tick.
    return {
      args: [],
      sql: `t.youtube_video_id is not null
            and coalesce(t.youtube_video_official, 0) <> 1`,
    };
  }

  if (kind === "isrc-recovery") {
    // THE FREE ISRC-RECOVERY WORKLIST. This catalogue-only pass asks Deezer for recording identity
    // before a row enters the billed anchor queue, so every predicate excludes a request that can
    // never clear the server's duration + identity gate. `has_isrc` is the maintained presence
    // mirror, not a re-spelled raw-ISRC expression: it is the leading key of the existing partial
    // `tracks_anchor_order_idx`, under the identical `spotify_uri is null` scope.
    //
    // The dedicated recovery ledger is load-bearing here. `isrc_attempted_at` cannot express this
    // pass: several paths write it, including the crawler at insert after its MusicBrainz look.
    // `backfill_deezer_attempted_at` belongs to the separate ISRC-gated enrichment worklist, so this
    // pass must not consume it either. A settling box-supplied search alone moves this watermark.
    const cutoff = new Date(
      Date.now() - ISRC_RECOVERY_REASK_AFTER_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    return {
      args: [cutoff],
      // `spotify_anchor_attempted_at is null` — FRESH ROWS ONLY, and this one is measured rather
      // than assumed. Without it the queue is a superset that also holds every row the billed anchor
      // sweep already tried and missed, and because those rows carry embeddings and high Ear scores
      // they sort AHEAD of the fresh ones under `ANCHOR_ORDER`: a live 300-row head was 100% already-
      // missed, 0% fresh. That is the same starvation this pass exists to cure, one layer down.
      // The two populations also recover at wildly different rates — 68% on fresh rows against 1%
      // on the residue (both measured against the production gate) — so the residue is deliberately
      // OUT OF SCOPE rather than merely deprioritized: it would spend ~121 ticks of requests to reach
      // the population worth asking. A row enters this queue exactly once, before it is ever billed.
      sql: `f.track_id is null
            and t.spotify_uri is null
            and t.has_isrc = 0
            and t.spotify_anchor_attempted_at is null
            and t.duration_ms > 0
            and t.dismissed_at is null
            and t.duplicate_of_track_id is null
            and ${ANCHOR_RULED_OUT_LABEL_CLAUSE}
            and (t.isrc_recovery_attempted_at is null or t.isrc_recovery_attempted_at < ?)`,
    };
  }

  if (kind === "anchor") {
    // THE ANCHOR WORKLIST (docs/catalogue-crawler.md § the anchor). Catalogue-only by construction
    // (`f.track_id is null` — a finding's Spotify id is its identity, never re-anchored), so
    // `kind: "anchor"` with `scope: "findings"` is contradictory (`f.track_id is not null` AND
    // `f.track_id is null`) and honestly returns an empty page — the anchor worklist is `all`/`catalogue`.
    // Only rows worth spending a billed Apify search on:
    //   · `spotify_uri is null`         — the derived worklist: un-anchored rows only.
    //   · `duration_ms > 0`             — a row with no measured length can never clear the verified
    //                                     search triple (the ±3s duration signal is missing), so a
    //                                     search on it is guaranteed-no-stamp money.
    //   · `dismissed_at is null`        — the operator's "not for me" (docs/the-ear.md); a dismissed
    //                                     row is out of the telescope, so an anchor buys nothing.
    //   · `duplicate_of_track_id is null` — a known duplicate of a finding is already in the archive.
    //   · the RE-ASK BACKOFF            — never attempted, OR attempted longer ago than the window.
    //   · the RETRY CAP                 — under `ANCHOR_MAX_ATTEMPTS` full attempts, so the window is
    //                                     a bounded run of tries and not a treadmill. NULL attempts
    //                                     coalesce to 0 (the column carries no `.default()` on
    //                                     purpose — see schema.ts).
    //   · ANCHORABLE AT ALL             — the sole credit is a real artist, not an `Unknown Artist` /
    //                                     `Various Artists` placeholder no search could ever match
    //                                     (`UNANCHORABLE_ARTISTS_JSON`).
    //   · THE RULED-OUT-LABEL VETO      — the operator's "not our lane", the capture ladder's tier −1
    //                                     in this queue. See `ANCHOR_RULED_OUT_LABEL_CLAUSE` above.
    // Every clause but one is a residual filter on the page `tracks_anchor_order_idx` hands back —
    // the same class as `duration_ms > 0` / `dismissed_at is null` beside them, evaluated on rows the
    // walk has already read, so THIS query's plan is unchanged (no new index, no widened index
    // predicate). `t.spotify_uri is null` is the exception: it is the literal the partial index's
    // predicate is matched against, so keep the two spelled the same (schema.ts).
    //
    // THE FUNNEL IS THE OTHER READER, and it is why the veto's spelling matters more than it looks:
    // `foldedFunnelScanStatement` interpolates this whole fragment four times into one covering scan
    // of `tracks`, so a clause that reads a column `tracks_funnel_scan_idx` does not carry costs that
    // scan its coverage. Growing that index alongside this clause is the ratified maintenance, not an
    // afterthought — see the index's own note in schema.ts.
    const cutoff = new Date(
      Date.now() - ANCHOR_REASK_AFTER_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    // The five PERMANENT exclusions come from the shared `anchorEligibilityClause` above — the same
    // fragment the identity envelope negates for its `refused` state, so the queue and the wire can
    // never disagree about a row. What stays HERE is what is local to the worklist: its catalogue
    // scope, the derived un-anchored predicate, the temporal re-ask backoff (BOUND cutoff), and the
    // ruled-out-label veto.
    const permanent = anchorEligibilityClause();

    return {
      args: [cutoff, ...permanent.args],
      sql: `f.track_id is null
            and t.spotify_uri is null
            and (t.spotify_anchor_attempted_at is null or t.spotify_anchor_attempted_at < ?)
            and ${ANCHOR_RULED_OUT_LABEL_CLAUSE}
            and ${permanent.sql}`,
    };
  }

  if (kind === "capture") {
    const cooldown = new Date(Date.now() - CAPTURE_FAILED_COOLDOWN_MS).toISOString();

    return {
      args: [cooldown, cooldown],
      // CAPTURE_MAX_FAILURES is a trusted module int (interpolated, like listTracks does);
      // the cooldown is BOUND. `wrong-audio` is a re-capture trigger (docs/the-ear.md).
      // `duplicate-cleared` is the operator's force-capture escape hatch (docs/the-ear.md §
      // Duplicates), and its status is STICKY — the generic update path never lets a machine
      // PATCH overwrite it (the track-update ruling guard) — so this arm carries its own
      // scheduling conditions off the columns the capture sweep DOES stamp:
      //   · `source_audio_key is null` — a SUCCESSFUL forced capture lands the key while the
      //     sentinel stays standing, and a captured row must never re-enter the capture queue
      //     (the sentinel is a duplicate override, not a standing re-capture order);
      //   · the same failure-cap + cooldown as the `failed` arm — a FAILED forced capture keeps
      //     the sentinel too (its status never becomes `failed`), so its retries are bounded by
      //     `source_audio_failures` / `source_audio_attempted_at` here instead.
      // The catalogue half also excludes a LONG-FORM row (`duration_ms < LONG_FORM_MS`, the
      // continuous-mix veto — docs/the-ear.md § The long-form veto): a mix is the fattest thing
      // the metered budget can buy and can never become a finding. Catalogue-scoped like the
      // dismissal — a FINDING is never duration-gated.
      // The catalogue half also excludes a DISMISSED row (`dismissed_at is null`): the operator's
      // "not for me" is the ruled-out-label veto's class (docs/the-ear.md § The operator's
      // actions) — a metered download must never be spent on a row he took out of the telescope.
      // Scoped to the catalogue branch: a finding is never dismissed, and capture is the only
      // stage that spends money (the veto's own scope), so analyze/embed are untouched.
      sql: `(t.capture_status is null
             or t.capture_status = 'pending'
             or t.capture_status = 'wrong-audio'
             or (t.capture_status = 'duplicate-cleared'
                 and t.source_audio_key is null
                 and t.source_audio_failures < ${CAPTURE_MAX_FAILURES}
                 and (t.source_audio_attempted_at is null or t.source_audio_attempted_at < ?))
             or (t.capture_status = 'failed'
                 and t.source_audio_failures < ${CAPTURE_MAX_FAILURES}
                 and (t.source_audio_attempted_at is null or t.source_audio_attempted_at < ?)))
            and (
              (f.track_id is not null and f.log_id is not null)
              or (f.track_id is null and t.capture_priority is not null and t.capture_priority >= 0
                  and t.dismissed_at is null
                  and t.duration_ms >= ${MIN_TRACK_MS}
                  and t.duration_ms < ${LONG_FORM_MS})
            )`,
    };
  }

  if (kind === "analyze") {
    return {
      args: [],
      // The `wrong-audio` guard: the key still points at the poisoned bytes until a fresh
      // capture overwrites it, so they must not be re-measured (docs/the-ear.md § Wrong audio).
      sql: `t.source_audio_key is not null
            and t.capture_status <> 'wrong-audio'
            and (t.analyzed_at is null or t.analyzed_from is null or t.analyzed_from <> 'full')`,
    };
  }

  return {
    args: [],
    // The `wrong-audio` guard: the quarantine dropped the vector but kept the bad key, so this
    // row must NOT re-embed the poisoned bytes (docs/the-ear.md § Wrong audio).
    //
    // `has_embedding = 0` rather than a `track_embeddings` anti-join, and that spelling is a
    // CONTRACT with `tracks_embed_queue_idx` (schema.ts), whose partial predicate carries the
    // same two clauses literally: SQLite only considers a partial index when the query's WHERE
    // provably implies its predicate, and a cross-table `not exists` never can.
    sql: `t.source_audio_key is not null
          and t.has_embedding = 0
          and t.capture_status <> 'wrong-audio'`,
  };
}

/**
 * The kinds that spend metered residential-proxy bandwidth, and so answer to the catalogue capture
 * budget. Named once and shared by the page read and the count, so the two can never disagree about
 * whether a queue is braked — the failure mode being a count that advertises work the queue refuses.
 */
const METERED_KINDS = new Set<TrackWorkKind>(["capture", "youtube-provenance"]);

/**
 * The kinds whose sweep runs the FULL YouTube ladder — search, rank, download, fingerprint — and so
 * needs the DTO's trust and bad-audio-memory signals to run it the same way. The capture sweep and
 * the provenance backfill share one implementation of that walk (capture-sweep.ts), so they must
 * share the facts it reads, or the shared walk would behave differently depending on who called it.
 */
const LADDER_KINDS = new Set<TrackWorkKind>(["capture", "youtube-provenance"]);

/** The hard ceiling on one worklist read — a sweep acts on a far smaller batch than this. */
const MAX_WORK_LIMIT = 200;

/** Hydrate only the bounded ID page selected by the due-work projection, in projection order. */
async function hydrateWorkRows(db: DueWorkClient, trackIds: readonly string[]): Promise<WorkRow[]> {
  if (trackIds.length === 0) {
    return [];
  }

  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: [...trackIds],
    sql: `select ${WORK_SELECT}
          from tracks t
          left join findings f on f.track_id = t.track_id
          where t.track_id in (${placeholders})`,
  });
  const rowsById = new Map(
    typedRows<WorkRow>(result.rows).map((row) => [row.track_id, row] as const),
  );

  return trackIds.flatMap((trackId) => {
    const row = rowsById.get(trackId);
    return row === undefined ? [] : [row];
  });
}

/**
 * Read one stage's worklist, in the order the money should be spent.
 *
 * The shared ladder is two ordered, limited reads — findings first, then only enough catalogue rows
 * to fill the page. Splitting the leading certification key removes the joined expression that made
 * SQLite sort the full candidate table. The three specialist queues keep their existing single
 * indexed read. No vector, feature blob, or certification column beyond the coordinate crosses the
 * wire.
 */
export async function listTrackWork(options: {
  kind: TrackWorkKind;
  limit?: number;
  scope?: TrackWorkScope;
}): Promise<TrackWorkItem[]> {
  const { kind, limit = 50, scope = "all" } = options;
  const page = Math.min(Math.max(1, Math.trunc(limit)), MAX_WORK_LIMIT);

  // THE BRAKE. Only the two METERED kinds are gated — `analyze` and `embed` read bytes that are
  // already bought and are free (the same reason the label veto is scoped to capture alone), and
  // `youtube-reverdict` is a keyless oEmbed read. `youtube-provenance` joins `capture` here because
  // it costs exactly what capture costs: a full candidate download through the residential proxy,
  // billed per GB. A backfill that quietly spent the catalogue's money while the operator believed
  // the brake was on would be the same bug the brake exists to prevent, wearing a new name. The
  // budget is consulted BEFORE the queue is read, so a shut budget is not a filter applied to a
  // page of candidates: those rows are never selected.
  const catalogueShut = METERED_KINDS.has(kind) ? !(await isCatalogueCaptureOpen()) : false;

  // A caller that asked for the catalogue explicitly gets an honest empty queue, with no
  // database round-trip at all — the answer is already known.
  if (catalogueShut && scope === "catalogue") {
    return [];
  }

  // …and a caller that asked for BOTH halves (the sweeps' default) gets the findings. The
  // narrowing is the whole safety property: the brake stops the catalogue, never the archive.
  const effectiveScope: TrackWorkScope = catalogueShut ? "findings" : scope;

  const db = await getDb();
  const dueCutoverEnabled = await isTrackWorkDueCutoverEnabled();

  let rows: WorkRow[];

  if (dueCutoverEnabled) {
    const selectedIds = await readTrackWorkDueIds(db, {
      kind,
      limit: page,
      scope: effectiveScope,
    });
    rows = await hydrateWorkRows(db, selectedIds);
  } else {
    // GOAL H CONTRACTION: this is the unchanged source-table selector retained while Goal C's
    // default-off cutover proves the due_work projection. Delete this branch only after the
    // projection has been promoted and its compatibility evidence is complete.
    const kindWhere = kindClause(kind);
    // The anchor-family worklists ride the existing anchor index order; on `isrc-recovery`,
    // `has_isrc` is fixed at 0, so `has_embedding` is the next indexed key and embedded rows come
    // first without a new index. The re-verdict rides its round-robin (oldest-ruled first). Those
    // specialist orders do NOT begin with certification and must remain single reads; every other
    // kind — the provenance backfill included — rides the split shared ladder below.
    const specialistOrder =
      kind === "anchor" || kind === "isrc-recovery"
        ? ANCHOR_ORDER
        : kind === "youtube-reverdict"
          ? REVERDICT_ORDER
          : null;

    const readRows = async (where: string, order: string, limit: number): Promise<WorkRow[]> => {
      const result = await db.execute({
        args: [...kindWhere.args, limit],
        // INDEXED BY on the anchor kind is load-bearing, not a hint. `tracks_anchor_order_idx` exists
        // for exactly this ORDER BY — same four columns, same direction, partial on `spotify_uri is
        // null` — so it walks in order and stops at LIMIT. The planner does not choose it: hosted
        // Turso rejects ANALYZE, so with no statistics it prefers an equality seek it can SEE
        // (`tracks_vendor_worklist_idx`, `is_catalogue=? AND capture_priority>?`) over an ordered walk
        // whose benefit it cannot measure, then pays `USE TEMP B-TREE FOR ORDER BY` over the result.
        // Measured on prod, plan only:
        //
        //   planner's choice: SEARCH t USING tracks_vendor_worklist_idx + TEMP B-TREE FOR ORDER BY
        //   INDEXED BY:       SCAN t USING tracks_anchor_order_idx, no sort
        //
        // The planner cannot value an ordering, only a filter — so every index added for some other
        // query becomes a more attractive wrong answer here. Pinning is the only stable fix.
        sql: `select ${WORK_SELECT}
              from tracks t${order === ANCHOR_ORDER ? " indexed by tracks_anchor_order_idx" : ""}
              left join findings f on f.track_id = t.track_id
              where ${where} and ${kindWhere.sql}
              ${order}
              limit ?`,
      });

      return typedRows<WorkRow>(result.rows);
    };

    if (specialistOrder !== null) {
      rows = await readRows(scopeClause(effectiveScope), specialistOrder, page);
    } else {
      const halves: Exclude<TrackWorkScope, "all">[] =
        effectiveScope === "all" ? ["findings", "catalogue"] : [effectiveScope];
      rows = [];

      for (const half of halves) {
        const remaining = page - rows.length;

        if (remaining === 0) {
          break;
        }

        rows.push(
          ...(await readRows(workHalfClause(kind, half), workOrder(kind, half), remaining)),
        );
      }
    }
  }

  const items: TrackWorkItem[] = rows.map((row) => {
    const artists = parseArtistsJson(row.artists_json);
    // The recovery-kind Deezer ask, plus the ANCHOR ask for an ISRC-LESS row only. Deezer's
    // tokenless quota is per-IP and the Worker's shared edge IPs are saturated, so the BOX runs
    // that search; the server still owns the SPELLING (deezer.ts `deezerSearchQuery`), so the sweep
    // never invents a query, exactly as with `anchorQuery`.
    const deezerQuery =
      kind === "isrc-recovery" || (kind === "anchor" && !row.isrc?.trim())
        ? deezerSearchQuery(artists, row.title)
        : undefined;

    return {
      artists,
      capturePriority: row.capture_priority === null ? null : Number(row.capture_priority),
      certified: Number(row.certified) === 1,
      durationMs: Number(row.duration_ms),
      isrc: row.isrc,
      label: row.label,
      logId: row.log_id,
      sourceAudioKey: row.source_audio_key,
      title: row.title,
      trackId: row.track_id,
      // The ANCHOR-only ready-made query, so the box's Apify sweep never builds it (anchor.ts
      // `anchorSearchQuery`). Attached for the `anchor` worklist ONLY; absent for every other kind.
      ...(kind === "anchor" ? { anchorQuery: anchorSearchQuery(artists, row.title) } : {}),
      ...(deezerQuery ? { deezerQuery } : {}),
      // The four CAPTURE-only trust/re-derive signals. Attached for the `capture` worklist
      // ONLY, so `analyze`/`embed` DTOs stay exactly as they were (byte-identical for those
      // sweeps). Each follows the finding-only capture DTO's omit-when-empty convention — a
      // missing BPM, a NULL provenance, a zero failure count and an empty channel set are all
      // OMITTED rather than surfaced — so the shape the sweep parses is unchanged by the migration.
      ...(kind === "capture"
        ? {
            analyzedFrom:
              row.analyzed_from === "full" || row.analyzed_from === "preview"
                ? row.analyzed_from
                : undefined,
            bpm:
              row.bpm !== null && Number.isFinite(Number(row.bpm)) && Number(row.bpm) > 0
                ? Number(row.bpm)
                : undefined,
            sourceAudioFailures:
              row.source_audio_failures !== null && Number(row.source_audio_failures) > 0
                ? Number(row.source_audio_failures)
                : undefined,
          }
        : {}),
      // THE BAD-AUDIO MEMORY rides BOTH ladder-running worklists. The provenance backfill runs the
      // same search → rank → download → fingerprint walk, so it wants the same pre-download videoId
      // filter: a candidate an earlier capture already proved wrong must not cost proxy bytes a
      // second time just because a different sweep is asking. It READS the memory and never writes
      // it — writing is a capture column, and the backfill moves none.
      // Deliberately NOT extended to the provenance kind: `bpm`/`analyzedFrom` feed the
      // capture→enrich re-derive and `sourceAudioFailures` the capture failure backoff, and the
      // backfill performs neither.
      ...(LADDER_KINDS.has(kind)
        ? {
            sourceAudioRejected:
              typeof row.source_audio_rejected === "string" && row.source_audio_rejected.trim()
                ? row.source_audio_rejected
                : undefined,
          }
        : {}),
    };
  });

  // The artist-own-channel trust signal is a SEPARATE batched read (a correlated subquery on
  // the main select would bloat every DTO), and it is CAPTURE-only — the same field, off the
  // same reader, the finding-only capture queue attaches (tracks.ts), so the two cannot drift.
  if (LADDER_KINDS.has(kind) && items.length > 0) {
    const byTrack = await readArtistYoutubeChannelIdsByTrack(
      db,
      items.map((item) => item.trackId),
    );

    for (const item of items) {
      const channelIds = byTrack.get(item.trackId);

      if (channelIds && channelIds.length > 0) {
        item.artistYoutubeChannelIds = channelIds;
      }
    }
  }

  return items;
}

/**
 * HOW BIG IS THE BACKLOG — the whole queue, not the page.
 *
 * `listTrackWork` is capped at 200 rows, so `tracks.length` from a page read answers "how many
 * did I get", never "how much is left". At catalogue scale those are different numbers by three
 * orders of magnitude, and the one the OPERATOR needs is the second: it is what decides whether
 * the GPU batch (docs/gpu-batch-embed.md) rents another hour, and how many. A batch that reports
 * "done" off a short final page while 8,000 rows are still queued is simply lying to him.
 *
 * So this is the same predicate, the same scope, the same brake — counted rather than paged.
 * The ORDER BY is dropped (a count does not care) and no column crosses the wire but the number.
 *
 * It is OPT-IN at every caller (`count=true` on `list_track_work`), because the 5-minute box
 * sweeps do not need it and should not pay for it. The `embed` predicate is backed by a partial
 * index (`tracks_embed_queue_idx`) that covers exactly the un-embedded rows, so THAT count reads
 * the backlog rather than the archive; `capture`/`analyze` have no such index and their counts
 * scan, which is why nothing on a hot path asks for one.
 */
export async function countTrackWork(options: {
  /**
   * An ALREADY-computed capture budget state, threaded in so the caller that also needs the state
   * (the funnel snapshot: it reads `getCatalogueCaptureState` once for its meters) does not force a
   * SECOND identical read here. Omitted, the capture count reads the brake itself, as before.
   */
  captureState?: CatalogueCaptureState;
  kind: TrackWorkKind;
  scope?: TrackWorkScope;
}): Promise<number> {
  const { captureState, kind, scope = "all" } = options;

  // The same brake, in the same order as the page read — a shut budget must not be able to
  // report a backlog the queue would refuse to hand out. Reuse a passed-in state; else read it.
  const catalogueShut = METERED_KINDS.has(kind)
    ? !(captureState ? captureState.open : await isCatalogueCaptureOpen())
    : false;

  if (catalogueShut && scope === "catalogue") {
    return 0;
  }

  const effectiveScope: TrackWorkScope = catalogueShut ? "findings" : scope;
  const db = await getDb();

  if (await isTrackWorkDueCutoverEnabled()) {
    return countTrackWorkDue(db, { kind, scope: effectiveScope });
  }

  // GOAL H CONTRACTION: this source-table count remains only as the default-off rollback path.
  const kindWhere = kindClause(kind);
  const where = `${scopeClause(effectiveScope)} and ${kindWhere.sql}`;

  // THE JOIN IS CONDITIONAL — and only in this count path (the page read above always needs `f`
  // for its SELECT and its ORDER BY). `findings.track_id` is unique, so a `left join findings`
  // the WHERE never mentions can neither filter nor fan a row out: it changes no `count(*)`. It
  // is not free, though — at 100k rows the planner still probes `findings` once per row, ~175 ms
  // of the 316 ms cold-start p50 (docs/local-database.md). So the join goes
  // in exactly when the predicate references it, derived STRUCTURALLY from the assembled clause
  // rather than a kind/scope truth table: the ONLY thing under an `f.` prefix is the `findings`
  // alias, so any `f.` fragment — the `findings`/`catalogue` scopes' `f.track_id`, `capture`'s
  // `f.log_id` — pulls the join in, and `embed`/`analyze` at `scope=all` (no `f.` at all) drop it.
  const needsFindings = where.includes("f.");
  const result = await db.execute({
    args: kindWhere.args,
    sql: `select count(*) as queued
          from tracks t
          ${needsFindings ? "left join findings f on f.track_id = t.track_id" : ""}
          where ${where}`,
  });

  return Number(typedRows<{ queued: number }>(result.rows)[0]?.queued ?? 0);
}
