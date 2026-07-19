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
// It is scoped to CAPTURE alone, deliberately. A ruling governs what Fluncle ACQUIRES
// (docs/label-entity.md — a capture IS an acquisition), not what he may measure. If the
// bytes are already bought, analysing and embedding them is free, and a vector is how the
// Ear gets to disagree with the ladder. So `analyze`/`embed` carry no veto — the vetoed
// row simply sorts last there, exactly as the-ear.md says.
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
import { isCatalogueCaptureOpen } from "./capture-budget";
import { LONG_FORM_MS, MIN_TRACK_MS } from "./catalogue";
import { parseArtistsJson } from "./artists";
import { getDb, typedRows } from "./db";
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
export type TrackWorkKind = "analyze" | "anchor" | "capture" | "embed";

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
 * re-derive) is byte-identical to what it did on the old queue. They are ABSENT for
 * `analyze`/`embed`, which read those columns off the row directly and never needed them here.
 */
export type TrackWorkItem = {
  /**
   * Which audio class BPM/key were last analyzed from — CAPTURE-only, so the sweep can
   * decide whether a just-landed capture must re-derive from the full song. Absent for
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
 * THE ORDER. One ORDER BY, evaluated in SQL — the queue is never re-sorted in the isolate.
 * See the module header: certified first, then the pre-audio ladder, then the DEMAND signal,
 * then newest-first within the findings, then the id.
 *
 * `coalesce(t.capture_priority, 0)` is what makes one clause serve both halves: every
 * finding reads 0 (the column is only ever written on a catalogue row), so the rung
 * cannot reorder the findings among themselves — and a VETOED catalogue row (−1) sorts
 * below an unranked one, which is precisely the intent.
 *
 * `coalesce(t.demand_score, 0)` is the DEMAND reorder (docs/catalogue-crawler.md § Demand),
 * and its POSITION is the whole contract: it sits AFTER `capture_priority`, so it only ever
 * reorders rows of the SAME tier — a demanded row is captured before an undemanded sibling at
 * its tier, never lifted across the ladder, and NEVER past the `capture_priority >= 0` veto
 * (that predicate excludes a ruled-out row in `kindClause` before this ORDER BY is reached).
 * A finding reads 0 here too (demand_score is only written where a demanded entity hangs off a
 * row), so it cannot reorder the findings among themselves.
 */
const WORK_ORDER = `order by (f.track_id is not null) desc,
  coalesce(t.capture_priority, 0) desc,
  coalesce(t.demand_score, 0) desc,
  coalesce(f.added_at, '') desc,
  t.track_id desc`;

/**
 * THE ANCHOR ORDER — the same "the order IS the budget" law as the capture ladder, for the
 * metered Apify anchor spend (docs/catalogue-crawler.md § the anchor). The anchor worklist is
 * catalogue-only (a finding's Spotify id is its identity), so there is no certified/findings
 * split here; the drain order is:
 *   1. EMBEDDED rows first (`embedding_blob is not null`) — a row Fluncle has already spent
 *      capture + embed money on is one he most wants recommendable, so anchor it first.
 *   2. Then `nearest_finding_score DESC NULLS LAST` — the Ear's best un-anchored candidates,
 *      the ones closest to his taste, ahead of the unranked tail.
 *   3. Then `track_id` — a deterministic tiebreak so a batch is reproducible.
 * Both ordering columns are read IN SQL (never selected into the isolate); the ranked, embedded
 * head rides `tracks_anchor_fill_queue_idx` (schema.ts).
 */
const ANCHOR_ORDER = `order by (t.embedding_blob is not null) desc,
  t.nearest_finding_score desc nulls last,
  t.track_id asc`;

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
 *   capture that landed the wrong master, rewound the row to the pre-audio ladder, and kept its
 *   old `source_audio_key` so the sweep can refuse the identical bad bytes. Its restored
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
export function kindClause(kind: TrackWorkKind): { args: string[]; sql: string } {
  if (kind === "anchor") {
    // THE ANCHOR WORKLIST (docs/catalogue-crawler.md § the anchor). Catalogue-only by construction
    // (`f.track_id is null` — a finding's Spotify id is its identity, never re-anchored), so
    // `kind: "anchor"` with `scope: "findings"` is contradictory (`f.track_id is not null` AND
    // `f.track_id is null`) and honestly returns an empty page — the anchor worklist is `all`/`catalogue`.
    // Only rows worth spending a billed Apify search on:
    //   · `spotify_uri is null`         — the derived worklist: un-anchored rows only.
    //   · `duration_ms > 0`             — a row with no measured length can never clear the verified
    //                                     search triple (the ±2s duration signal is missing), so a
    //                                     search on it is guaranteed-no-stamp money.
    //   · `dismissed_at is null`        — the operator's "not for me" (docs/the-ear.md); a dismissed
    //                                     row is out of the telescope, so an anchor buys nothing.
    //   · `duplicate_of_track_id is null` — a known duplicate of a finding is already in the archive.
    //   · the RE-ASK BACKOFF            — never attempted, OR attempted longer ago than the window.
    const cutoff = new Date(
      Date.now() - ANCHOR_REASK_AFTER_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    return {
      args: [cutoff],
      sql: `f.track_id is null
            and t.spotify_uri is null
            and t.duration_ms > 0
            and t.dismissed_at is null
            and t.duplicate_of_track_id is null
            and (t.spotify_anchor_attempted_at is null or t.spotify_anchor_attempted_at < ?)`,
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
    // The `wrong-audio` guard: the quarantine nulled the vector but kept the bad key, so this
    // row must NOT re-embed the poisoned bytes (docs/the-ear.md § Wrong audio).
    sql: `t.source_audio_key is not null
          and t.embedding_blob is null
          and t.capture_status <> 'wrong-audio'`,
  };
}

/** The hard ceiling on one worklist read — a sweep acts on a far smaller batch than this. */
const MAX_WORK_LIMIT = 200;

/**
 * Read one stage's worklist, in the order the money should be spent.
 *
 * The whole read is one indexed statement: the predicate and the ordering are evaluated in
 * SQL and only the page comes back, so the cost is the page and not the archive. No vector,
 * no feature blob, and no certification column beyond the coordinate ever crosses the wire.
 */
export async function listTrackWork(options: {
  kind: TrackWorkKind;
  limit?: number;
  scope?: TrackWorkScope;
}): Promise<TrackWorkItem[]> {
  const { kind, limit = 50, scope = "all" } = options;
  const page = Math.min(Math.max(1, Math.trunc(limit)), MAX_WORK_LIMIT);

  // THE BRAKE. Only `capture` spends money, so only `capture` is gated — `analyze` and
  // `embed` read bytes that are already bought and are free (the same reason the label veto
  // is scoped to capture alone). The budget is consulted BEFORE the queue is read, so a shut
  // budget is not a filter applied to a page of candidates: those rows are never selected.
  const catalogueShut = kind === "capture" ? !(await isCatalogueCaptureOpen()) : false;

  // A caller that asked for the catalogue explicitly gets an honest empty queue, with no
  // database round-trip at all — the answer is already known.
  if (catalogueShut && scope === "catalogue") {
    return [];
  }

  // …and a caller that asked for BOTH halves (the sweeps' default) gets the findings. The
  // narrowing is the whole safety property: the brake stops the catalogue, never the archive.
  const effectiveScope: TrackWorkScope = catalogueShut ? "findings" : scope;

  const kindWhere = kindClause(kind);
  // The `anchor` worklist rides its own budget-order (embedded + ranked first); every other kind
  // rides the shared capture ladder.
  const order = kind === "anchor" ? ANCHOR_ORDER : WORK_ORDER;
  const db = await getDb();
  const result = await db.execute({
    args: [...kindWhere.args, page],
    sql: `select ${WORK_SELECT}
          from tracks t
          left join findings f on f.track_id = t.track_id
          where ${scopeClause(effectiveScope)} and ${kindWhere.sql}
          ${order}
          limit ?`,
  });

  const items: TrackWorkItem[] = typedRows<WorkRow>(result.rows).map((row) => {
    const artists = parseArtistsJson(row.artists_json);

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
  if (kind === "capture" && items.length > 0) {
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
  kind: TrackWorkKind;
  scope?: TrackWorkScope;
}): Promise<number> {
  const { kind, scope = "all" } = options;

  // The same brake, in the same order as the page read — a shut budget must not be able to
  // report a backlog the queue would refuse to hand out.
  const catalogueShut = kind === "capture" ? !(await isCatalogueCaptureOpen()) : false;

  if (catalogueShut && scope === "catalogue") {
    return 0;
  }

  const effectiveScope: TrackWorkScope = catalogueShut ? "findings" : scope;
  const kindWhere = kindClause(kind);
  const where = `${scopeClause(effectiveScope)} and ${kindWhere.sql}`;

  // THE JOIN IS CONDITIONAL — and only in this count path (the page read above always needs `f`
  // for its SELECT and its ORDER BY). `findings.track_id` is unique, so a `left join findings`
  // the WHERE never mentions can neither filter nor fan a row out: it changes no `count(*)`. It
  // is not free, though — at 100k rows the planner still probes `findings` once per row, ~175 ms
  // of the 316 ms cold-start p50 (measured 2026-07-12; docs/local-database.md). So the join goes
  // in exactly when the predicate references it, derived STRUCTURALLY from the assembled clause
  // rather than a kind/scope truth table: the ONLY thing under an `f.` prefix is the `findings`
  // alias, so any `f.` fragment — the `findings`/`catalogue` scopes' `f.track_id`, `capture`'s
  // `f.log_id` — pulls the join in, and `embed`/`analyze` at `scope=all` (no `f.` at all) drop it.
  const needsFindings = where.includes("f.");
  const db = await getDb();
  const result = await db.execute({
    args: kindWhere.args,
    sql: `select count(*) as queued
          from tracks t
          ${needsFindings ? "left join findings f on f.track_id = t.track_id" : ""}
          where ${where}`,
  });

  return Number(typedRows<{ queued: number }>(result.rows)[0]?.queued ?? 0);
}
