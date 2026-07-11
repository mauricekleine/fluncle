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
//   3. Then newest-first within the findings (today's behaviour), and the track id as a
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

import { parseArtistsJson } from "./artists";
import { getDb, typedRows } from "./db";
import { CAPTURE_FAILED_COOLDOWN_MS, CAPTURE_MAX_FAILURES } from "./tracks";

/**
 * Which stage of the audio pipeline a worklist is for. The three are strictly sequential
 * for any one track — capture puts the bytes in private R2, analyze reads them for
 * BPM/key/features, embed reads them for the MuQ vector — but they are INDEPENDENT
 * queues: capture never gates the other two (docs/track-lifecycle.md), and analyze never
 * gates embed.
 */
export type TrackWorkKind = "analyze" | "capture" | "embed";

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
 * One row of work. It carries the track's identity and the two facts a sweep needs to act
 * — the captured-audio key and whether the track is certified — and NOTHING else.
 *
 * `certified` is on the DTO on purpose: it is what tells a sweep it must NOT write a
 * certification field (a `--status`, a note, a video) on this row. `logId` is null exactly
 * when `certified` is false, because the coordinate lives on the certification.
 */
export type TrackWorkItem = {
  artists: string[];
  /** The Ear's pre-audio ladder tier, or null on a finding / an unranked catalogue row. */
  capturePriority: number | null;
  /** True when a `findings` row exists — the certification rail's flag, in the DTO. */
  certified: boolean;
  durationMs: number;
  isrc: null | string;
  label: null | string;
  /** Null for every catalogue track: the coordinate lives on `findings`. */
  logId: null | string;
  /** The private-R2 key of the captured full song. Presence = there is audio to work on. */
  sourceAudioKey: null | string;
  title: string;
  trackId: string;
};

type WorkRow = {
  artists_json: string;
  capture_priority: null | number;
  certified: number;
  duration_ms: number;
  isrc: null | string;
  label: null | string;
  log_id: null | string;
  source_audio_key: null | string;
  title: string;
  track_id: string;
};

const WORK_SELECT = `t.track_id, t.title, t.artists_json, t.isrc, t.label, t.duration_ms,
  t.source_audio_key, t.capture_priority, f.log_id as log_id,
  (f.track_id is not null) as certified`;

/**
 * THE ORDER. One ORDER BY, evaluated in SQL — the queue is never re-sorted in the isolate.
 * See the module header: certified first, then the pre-audio ladder, then newest-first
 * within the findings, then the id.
 *
 * `coalesce(t.capture_priority, 0)` is what makes one clause serve both halves: every
 * finding reads 0 (the column is only ever written on a catalogue row), so the rung
 * cannot reorder the findings among themselves — and a VETOED catalogue row (−1) sorts
 * below an unranked one, which is precisely the intent.
 */
const WORK_ORDER = `order by (f.track_id is not null) desc,
  coalesce(t.capture_priority, 0) desc,
  coalesce(f.added_at, '') desc,
  t.track_id desc`;

/** The scope's WHERE fragment. Static literals — never interpolated user input. */
function scopeClause(scope: TrackWorkScope): string {
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
 *   it is still worth trying (`pending`/NULL always; a `failed` row only past the cooldown
 *   and below the failure cap; a terminal `done`/`unmatched` never re-burned). Then the two
 *   halves diverge, because acquisition needs different things of each:
 *     · a FINDING needs a coordinate — the R2 key is `<logId>/<sha256>.<ext>`, so a
 *       coordinate-less straggler is not capturable.
 *     · a CATALOGUE track needs a RANKED, NON-VETOED tier. `capture_priority is not null`
 *       is the "the Ear has looked at this" gate — capturing an unranked row would be
 *       draining the queue in insertion order, which is the exact failure this queue
 *       exists to prevent. `>= 0` is the veto (see the module header).
 *
 * `analyze` — the full-audio analysis worklist: audio on file, and the stored analysis did
 *   not come from it (`analyzed_from <> 'full'`, or nothing analysed at all). This is
 *   DATA-derived, not status-derived: a catalogue track has no `enrichment_status` (that
 *   column is a certification concern), so the queue reads the columns that actually say
 *   whether the work is done.
 *
 * `embed` — the MuQ worklist: audio on file, no vector. The captured full song is the only
 *   admissible source (a 30s preview yields a garbage vector — ratified), so the key gate
 *   is the point, not a convenience.
 */
function kindClause(kind: TrackWorkKind): { args: string[]; sql: string } {
  if (kind === "capture") {
    const cooldown = new Date(Date.now() - CAPTURE_FAILED_COOLDOWN_MS).toISOString();

    return {
      args: [cooldown],
      // CAPTURE_MAX_FAILURES is a trusted module int (interpolated, like listTracks does);
      // the cooldown is BOUND.
      sql: `(t.capture_status is null
             or t.capture_status = 'pending'
             or (t.capture_status = 'failed'
                 and t.source_audio_failures < ${CAPTURE_MAX_FAILURES}
                 and (t.source_audio_attempted_at is null or t.source_audio_attempted_at < ?)))
            and (
              (f.track_id is not null and f.log_id is not null)
              or (f.track_id is null and t.capture_priority is not null and t.capture_priority >= 0)
            )`,
    };
  }

  if (kind === "analyze") {
    return {
      args: [],
      sql: `t.source_audio_key is not null
            and (t.analyzed_at is null or t.analyzed_from is null or t.analyzed_from <> 'full')`,
    };
  }

  return {
    args: [],
    sql: `t.source_audio_key is not null and t.embedding_json is null`,
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
  const kindWhere = kindClause(kind);
  const db = await getDb();
  const result = await db.execute({
    args: [...kindWhere.args, page],
    sql: `select ${WORK_SELECT}
          from tracks t
          left join findings f on f.track_id = t.track_id
          where ${scopeClause(scope)} and ${kindWhere.sql}
          ${WORK_ORDER}
          limit ?`,
  });

  return typedRows<WorkRow>(result.rows).map((row) => ({
    artists: parseArtistsJson(row.artists_json),
    capturePriority: row.capture_priority === null ? null : Number(row.capture_priority),
    certified: Number(row.certified) === 1,
    durationMs: Number(row.duration_ms),
    isrc: row.isrc,
    label: row.label,
    logId: row.log_id,
    sourceAudioKey: row.source_audio_key,
    title: row.title,
    trackId: row.track_id,
  }));
}
