import { type TrackUpdateResult } from "@fluncle/contracts";
import { type InStatement } from "@libsql/client";

export type { TrackUpdateResult };

/** The complete vocabulary written by the capture/provenance sweeps. */
export const YOUTUBE_VERIFICATION_VALUES = [
  "archive-match",
  "inconclusive",
  "metadata-match",
  "no-match",
  "preview-match",
] as const;

export type YoutubeVerification = (typeof YOUTUBE_VERIFICATION_VALUES)[number];

export function isYoutubeVerification(value: unknown): value is YoutubeVerification {
  return YOUTUBE_VERIFICATION_VALUES.some((candidate) => candidate === value);
}

// Generic admin track update — the write-back path for both the async enrichment
// agent and manual operator curation. Writes an
// ALLOW-LIST of curation/enrichment fields only; identity fields (title, artists,
// Spotify ids, Log ID) are immutable once set — isrc/logId accept a one-time
// backfill into a null slot (the ISRC-fallback straggler repair), never a
// change. Backs PATCH /api/admin/tracks/:id.

import { isLogId } from "../log-id";
import { parseArtistsJson } from "./artists";
import { insertCurrentSonarTrackArtifactChangeInTransaction } from "./artifact-changes";
import { getDb, typedRow } from "./db";
import { purgeLogCache } from "./edge-cache";
import {
  CLEAR_EMBEDDING_SQL,
  clearEmbeddingSatellite,
  SET_EMBEDDING_SQL,
  writeEmbeddingSatellite,
} from "./embedding";
import { purgeTrackEntityPages } from "./entity-cache-purge";
import { type AdminRole } from "./env";
import { type IdentityMethod } from "./identity-envelope";
import { hasIsrc } from "./isrc";
import { resolveLogId } from "./log-id";
import {
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  markDueWorkSourceMaintenanceStatements,
} from "./due-work";
import { ApiError } from "./spotify";
import { checkYoutubeOfficial } from "./youtube-official";
import { upsertTrackDuplicateKeyStatement } from "./track-duplicate-keys";

export type TrackUpdate = {
  /**
   * BPM/key ANALYSIS PROVENANCE (RFC bpm-key-accuracy) — machine-measured analysis
   * metadata the AGENT tier may write (like `features`/`embedding`). All INTERNAL, so
   * NONE is in VISIBLE_FIELDS: writing them moves no public surface and must not bump
   * updated_at / the sitemap lastmod. `analyzedFrom` = which audio class the analysis ran
   * on ("full" the captured song | "preview" a 30s preview); it is the field the capture
   * sweep's re-derive predicate reads. `analyzedAt` is the analysis-write ISO stamp;
   * `bpmSource`/`keySource` the analyzer's source strings; `bpmConfidence`/`keyConfidence`
   * its 0..1 confidences. See schema.ts.
   */
  analyzedAt?: string;
  analyzedFrom?: "preview" | "full";
  bpm?: number;
  bpmConfidence?: number;
  bpmSource?: string;
  /**
   * The full-song capture side-channel state (RFC full-audio, the `fluncle-capture`
   * cron). All five are machine-measured analysis fields the AGENT tier may write
   * (like `enrichmentStatus`/`embedding`) — internal, so NONE is in VISIBLE_FIELDS: a
   * capture write moves no public surface and must not bump updated_at / the sitemap
   * lastmod. `captureStatus` is the enum (pending|done|unmatched|failed, plus the two
   * wrong-audio states below);
   * `sourceAudioKey` is the R2 key of the captured song (presence = captured);
   * `sourceAudioCapturedAt`/`sourceAudioAttemptedAt` are ISO stamps; `sourceAudioFailures`
   * is the consecutive-failure count driving the backoff window. See schema.ts.
   *
   * `wrong-audio` / `quarantine-cleared` are the wrong-audio quarantine states
   * (docs/the-ear.md § Wrong audio), and `duplicate-cleared` is the operator's force-capture
   * override (docs/the-ear.md § Duplicates). They are written by the `rank_catalogue` sweep and
   * the `clear_wrong_audio` / `force_capture` ops DIRECTLY (not through this generic path — the
   * HTTP handler's enum admits only the four machine statuses), but they belong to the same
   * `capture_status` column, so the enum carries them for completeness. A machine write through
   * this path can never OVERWRITE `duplicate-cleared` — see the ruling guard at the write below.
   */
  captureStatus?:
    | "done"
    | "duplicate-cleared"
    | "failed"
    | "pending"
    | "quarantine-cleared"
    | "unmatched"
    | "wrong-audio";
  /**
   * THE CAPTURE VERIFICATION VERDICT (docs/the-ear.md § Wrong audio) — machine-measured provenance
   * of the capture, like `analyzedFrom`. Internal, NOT in VISIBLE_FIELDS/CERTIFICATION_FIELDS: it
   * describes the recording, applies to a catalogue row or a finding, and moves no public surface.
   *   - `preview-match` / `unverified` — the ingest gate's verdict (matched the ISRC preview, or
   *     abstained: no preview source / no fpcalc).
   *   - `mismatch` — the captured audio failed the preview check. On a FINDING it drives the
   *     /admin attention queue (the operator rules with `flag_wrong_audio`); on a CATALOGUE row it
   *     rides alongside the wrong-audio quarantine as the lens's honest WHY.
   */
  captureVerification?: "mismatch" | "preview-match" | "unverified";
  /** ISO of the last capture-verification check (paired with `captureVerification`). */
  captureVerifiedAt?: string;
  /**
   * Firecrawl-derived FACTUAL context (creative fuel for the observation script
   * + video agent). Internal only — never on /log, never in JSON-LD/RSS. Writing
   * it alone does NOT bump updated_at (it moves no public surface).
   */
  contextNote?: string;
  /**
   * PROVENANCE — the `context_distil` prompt version that produced `contextNote`
   * (0 = the registry's baked default, N = override N; NULL when no prompt produced it,
   * i.e. the raw-snippet fallback). Internal like `contextNote`, so writing it moves no
   * public lastmod. See lib/server/prompts.ts + docs/agents/prompt-registry.md.
   */
  contextPromptVersion?: number | null;
  /**
   * The context-fetch reliability marker (the `context_track` queue's resume state).
   * Internal only — never surfaced through public DTOs, and (like contextNote)
   * writing it does NOT bump updated_at. See schema.ts `contextStatus`.
   */
  contextStatus?: "pending" | "resolved" | "empty" | "failed";
  /**
   * The finding's MuQ audio embedding as a JSON array of 1024 floats — `vector32()`
   * converts it to a native `F32_BLOB(1024)` in the `track_embeddings` satellite
   * server-side. Internal analysis fuel like
   * `features` — written by the on-box `fluncle-embed` cron, never rendered, so writing it does NOT bump
   * updated_at (a whole-archive embed backfill must move no public lastmod). It IS the
   * sonic-similarity space `list_similar_tracks` ranks over; the handler validates the
   * 1024-d shape before it reaches here. See docs/track-lifecycle.md.
   */
  embedding?: string;
  enrichmentStatus?: "pending" | "processing" | "done" | "failed";
  /** Raw audio feature vector as a JSON string (training data for the classifier). */
  features?: string;
  /**
   * The sonic galaxy assignment (browse-by-feel RFC) — the `galaxy_id` FK the on-box
   * `fluncle-cluster` cron writes each night (the assignment-only step), an internal
   * grouping field like `embedding`. NOT in VISIBLE_FIELDS: an assignment moves no
   * public surface (it surfaces only once the galaxy is operator-named), so it must
   * not bump updated_at / the sitemap lastmod — the built-in `purgeLogCache` still
   * refreshes the finding's `/log` edge so the galaxy prose lands. Empty string clears
   * it (re-queue) — null, not "", so `galaxy_id IS NULL` reads it as unassigned.
   */
  galaxyId?: string;
  /** One-time backfill into a null isrc slot; rejected when one is already set. */
  isrc?: string;
  key?: string;
  keyConfidence?: number;
  keySource?: string;
  /**
   * One-time backfill into a null log_id slot: "auto" derives the coordinate
   * from the found date + isrc (Spotify id fallback), or pass an explicit
   * coordinate. Rejected when one is already set — coordinates are permanent.
   */
  logId?: string;
  note?: string;
  /**
   * PROVENANCE — the `note_author` prompt version that wrote `note` (0 = the registry's
   * baked default, N = override N). Set explicitly by the authoring path; when `note` is
   * written WITHOUT it, the version is cleared to NULL, because an operator-typed note was
   * written by no prompt. See lib/server/prompts.ts + docs/agents/prompt-registry.md.
   */
  notePromptVersion?: number | null;
  /**
   * Word-level caption timings for the spoken observation, as a JSON string
   * (`ObservationAlignment` from lib/server/observation.ts). Drives the synced radio
   * subtitles. Empty string clears it. NOT in VISIBLE_FIELDS: it describes an EXISTING
   * artifact (captured at render time alongside the audio, or back-filled later via
   * forced-alignment), so writing it must move no public lastmod.
   */
  observationAlignmentJson?: string;
  /** Fluncle's spoken observation R2 url (<log-id>/observation.mp3); visible field. */
  observationAudioUrl?: string;
  /** The observation's length in ms (probed by the agent at render time). */
  observationDurationMs?: number;
  /** When the observation was rendered (ISO). */
  observationGeneratedAt?: string;
  /**
   * The spoken observation SCRIPT (the voice-gated prose passed to the render).
   * Mirrors the R2 `observation.json` `text` on the row so the admin dialog can show
   * the transcript without an R2 round-trip. Internal (the transcript of an internal
   * artifact) — never on the public contract, and NOT in VISIBLE_FIELDS: on a fresh
   * render the sibling `observationAudioUrl` already bumps lastmod, and the one-off
   * back-migration writes it standalone (must move no public surface).
   */
  /**
   * PROVENANCE — the `observation_script` prompt version this script was authored under
   * (0 = the registry's baked default, N = override N; NULL when the sweep fell back to
   * its baked-in prompt). See lib/server/prompts.ts + docs/agents/prompt-registry.md.
   */
  observationPromptVersion?: number | null;
  observationScript?: string;
  /** ISO of the last full-song capture attempt (backoff-cooldown anchor). See captureStatus. */
  sourceAudioAttemptedAt?: string;
  /**
   * The captured song's SIZE in bytes — the meter behind the capture budget's byte cap
   * (./capture-budget.ts). A measurement of the acquisition, written by the capture sweep
   * alongside the key, and internal like the rest of the capture side-channel.
   */
  sourceAudioBytes?: number;
  /** ISO stamp when the full-song bytes landed in R2. See captureStatus. */
  sourceAudioCapturedAt?: string;
  /** Consecutive capture failures (drives the backoff window). See captureStatus. */
  sourceAudioFailures?: number;
  /** The R2 key of the captured full song (presence = captured). See captureStatus. */
  sourceAudioKey?: string;
  /**
   * THE BAD-AUDIO MEMORY (docs/the-ear.md § Wrong audio) — a JSON array of the sources this
   * track's captures have been REJECTED from ({ videoId?, sha256, reason, at }, capped ~10),
   * written by the capture sweep's ingest gate on a fingerprint mismatch. Internal capture
   * side-channel like `sourceAudioKey`; empty string clears it.
   */
  sourceAudioRejected?: string;
  /**
   * Banked fingerprint evidence from a SoundCloud provenance rung. The two values name the
   * reference that was compared; neither is YouTube evidence and neither may move YouTube fields.
   */
  sourceVerification?: "soundcloud-archive-match" | "soundcloud-preview-match";
  /** The AI model that authored the video, in <provider>/<model> notation. */
  videoModel?: string;
  /** The reasoning/thinking effort the authoring model ran at (e.g. "high"). */
  videoModelReasoning?: string;
  /**
   * The two-master layout signal: an ISO timestamp set
   * when the SQUARE crop source ships as footage.mp4. Its presence flips archive
   * surfaces to MT crops; absent, they fall back to the legacy portrait footage.
   * Empty string clears it (back to legacy). Idempotent re-ships re-stamp it.
   */
  videoSquaredAt?: string;
  videoUrl?: string;
  /** The video's travelling vehicle (diversity ledger; surfaced in /api/tracks). */
  videoVehicle?: string;
  /** The video's grain FAMILY (grain ledger; surfaced in /api/tracks). */
  videoGrain?: string;
  /** The video's visual REGISTER (register ledger; surfaced in /api/tracks). */
  videoRegister?: string;
  /** The video's coarse palette HUE-BUCKET tag (palette ledger; surfaced in /api/tracks). */
  videoPalette?: string;
  /** The video's plate-lane SUBJECT KIND (plate-subject ledger; render.json `plateSubject`). */
  videoPlateSubject?: string;
  /** The video's dominant STRUCTURAL family (structure ledger; render.json `structure.dominant`). */
  videoStructure?: string;
  /**
   * ASK THE SERVER TO RE-RULE the officialness of the id this row ALREADY holds — the widened
   * heuristic's way of reaching rows ruled under a narrower one, with no id and no capture column
   * moving. Carries no verdict: the server re-runs the same oEmbed check and writes what it gets.
   *
   * It can only ever PROMOTE. A row already at `official = 1` is left alone, so a re-ask can never
   * revoke a link Fluncle has been serving on the strength of a channel that has since renamed
   * itself — the widening exists to say yes more often, never to start saying no.
   */
  youtubeReverdict?: boolean;
  /**
   * WHAT THE PROVENANCE SWEEP FOUND (docs/agents/hermes/scripts/capture-sweep.ts § the provenance
   * phase). The backfill re-runs capture's whole ladder — search, rank, download, fingerprint —
   * against a row whose audio was captured before the id was kept, then throws the candidate bytes
   * away. So it has capture's PROOF without any capture WRITE, and this field is how it says so:
   *
   *   · `preview-match` — the fingerprint gate accepted an upload against the track's ISRC-resolved
   *     official preview. Sent WITH `youtubeVideoId`, and it is the alternative to
   *     `captureVerification: "preview-match"` for authorizing that id.
   *   · `archive-match` — the same fingerprint proof from the CATALOGUE ladder's segment rung, where
   *     the reference was the row's own archived master rather than a 30s preview. A separate value
   *     because the field names what was compared, and calling an archive comparison a preview one
   *     would be a small lie for no gain; it carries the identical claim (`method: "fingerprint"`).
   *   · `metadata-match` — the catalogue ladder's Topic rung. The upload was matched on ARTIST,
   *     TITLE and LENGTH and on nothing else, and it sat on an `<Artist> - Topic` art-track channel,
   *     which is YouTube minting the rights-holder's own delivered master. NO AUDIO WAS COMPARED, so
   *     it is stored as `method: "search"` — the Spotify anchor's claim class, which the /identity
   *     page renders as "matched by artist, title, and length". It must never render as a
   *     fingerprint, and the column below is what keeps the two apart.
   *   · `no-match` — the ladder concluded and found nothing. Sent with NO id; it stamps
   *     `youtube_verified_at`, which is what keeps the row out of the worklist's re-ask window
   *     instead of re-buying the same download every tick, and moves the can't-conclude streak.
   *   · `inconclusive` — the ladder RAN and could not conclude (the CDN refused every section it
   *     tried). Sent with NO id. It earns no stamp and no receipt — it was not an answer — but it
   *     moves the streak, because a row that can never be concluded would otherwise be re-served
   *     every tick forever and starve everything behind it.
   *
   * Deliberately SEPARATE from `captureVerification`: that field is the stored audio's provenance
   * and moves capture columns, and this sweep must never move one.
   */
  youtubeVerification?: YoutubeVerification;
  /**
   * THE CAPTURE'S YOUTUBE PROVENANCE (db/schema.ts § youtube_video_id) — the id of the upload a
   * fingerprint gate verified for this recording. Internal capture side-channel like
   * `sourceAudioKey`, and NOT in VISIBLE_FIELDS: keeping it moves no public lastmod.
   *
   * It means "a video whose audio fingerprint-matched this recording" — NOT "the official video".
   * A blend, a rip, or a fan upload carries the original's audio and passes the gate for exactly
   * that reason, which is why `youtube_video_official` and not this column is what public serving
   * reads.
   *
   * The caller sends ONLY the id, and only beside proof (`captureVerification` or
   * `youtubeVerification` at `preview-match`). The officialness verdict and its stamp are decided
   * server-side (lib/server/youtube-official.ts) and are deliberately absent from this type — a box
   * sweep can report what it captured, never grant permission for it to be shown.
   */
  youtubeVideoId?: string;
};

// The fields whose write changes a PUBLIC surface, so it should move the
// sitemap/log `lastmod` (updated_at). Everything else (features, contextNote) is
// internal training/creative fuel: written by the enrichment agent, never
// rendered, so it must not bump lastmod (contextStatus is likewise internal —
// the context-fetch resume marker). isrc/logId backfills are identity
// repairs that DO surface (the coordinate appears everywhere), so they count.
const VISIBLE_FIELDS = new Set<keyof TrackUpdate>([
  "bpm",
  "enrichmentStatus",
  "isrc",
  "key",
  "logId",
  "note",
  "observationAudioUrl",
  "observationDurationMs",
  "observationGeneratedAt",
  "videoGrain",
  "videoModel",
  "videoModelReasoning",
  "videoPalette",
  "videoPlateSubject",
  "videoRegister",
  "videoStructure",
  "videoSquaredAt",
  "videoUrl",
  "videoVehicle",
]);

// SOURCE HIERARCHY — operator > rekordbox > DSP. An agent (DSP) write NEVER
// downgrades a value a human or Rekordbox graded. `bpm_source`/`key_source` record
// who last set each value; the DSP key/BPM estimator is weaker than a DJ-graded
// Rekordbox key (documented mode/relative-key confusion), so letting an agent-tier
// enrichment overwrite a `rekordbox`/`operator` value is a REGRESSION, not an
// upgrade. These are the sources an agent may not clobber.
const PROTECTED_SOURCES = new Set(["operator", "rekordbox"]);

// ── THE CERTIFICATION RAIL ───────────────────────────────────────────────────
//
// Every field here writes a `findings` column — the CERTIFICATION half of the pair
// (docs/track-lifecycle.md). A CATALOGUE track (a `tracks` row with NO `findings`
// row — docs/the-ear.md) has no such row, so none of them is writable on one, and
// this set is the enforcement point for the rule that decides it.
//
// THE RULE: analysis is a measurement, certification is a claim. BPM, key, features,
// the MuQ vector and the captured audio are true of the RECORDING and say nothing —
// so they apply to any track, certified or not, and the audio pipeline (track-work.ts)
// happily works a catalogue row. But everything Fluncle SAYS — the note, the context
// note, the spoken observation, the video, the galaxy, the publish state, and the
// coordinate itself — is a claim about a track he has BEEN to. **Fluncle does not
// speak about an uncertified track** (ratified canon), and a catalogue track must
// never acquire a note, an observation, a video, or a publish by accident.
//
// Why it is enforced HERE rather than left to the SQL: `update findings … where
// track_id = ?` on a catalogue track simply matches zero rows. It would SUCCEED,
// silently, reporting the fields as written — the worst possible failure. So an
// uncertified write of any of these is a loud 409 (`uncertified`), and this path
// never INSERTs a `findings` row: certifying a track is `publish_track`'s job alone.
const CERTIFICATION_FIELDS = new Set<keyof TrackUpdate>([
  "contextNote",
  "contextPromptVersion",
  "contextStatus",
  "enrichmentStatus",
  "galaxyId",
  "logId",
  "note",
  "notePromptVersion",
  "observationAlignmentJson",
  "observationAudioUrl",
  "observationDurationMs",
  "observationGeneratedAt",
  "observationPromptVersion",
  "observationScript",
  "videoGrain",
  "videoModel",
  "videoModelReasoning",
  "videoPalette",
  "videoPlateSubject",
  "videoRegister",
  "videoStructure",
  "videoSquaredAt",
  "videoUrl",
  "videoVehicle",
]);

type ExistingRow = {
  added_at: string | null;
  // The names this recording is credited to, as stored JSON — read ONLY by the YouTube
  // officialness gate, which compares them against the upload's channel.
  artists_json: string | null;
  bpm_source: string | null;
  // 1 when a `findings` row exists — i.e. the track is a FINDING, not a catalogue row.
  certified: number;
  isrc: string | null;
  key_source: string | null;
  // The RAW `tracks.label` spelling — the officialness gate's fallback label name, for a row the
  // crawler minted before it had a canonical `labels` row to point at.
  label: string | null;
  // The CANONICAL `labels.name` behind `tracks.label_id`, the officialness gate's first choice.
  label_name: string | null;
  log_id: string | null;
  title: string;
  // Already-held capture provenance, so the fill-empty-only rule can short-circuit BEFORE
  // spending an oEmbed request on a row that will not take the answer anyway.
  youtube_video_id: string | null;
  // The standing officialness verdict, read so a re-verdict can refuse to DEMOTE a row already
  // at 1 — the widening only ever says yes more often.
  youtube_video_official: number | null;
};

/**
 * The names the YouTube officialness gate compares an upload's channel against: everyone this
 * recording is credited to, plus the label it came out on.
 *
 * BOTH label spellings go in, and the order is not a preference — `isOfficialAuthor` accepts on
 * equality with ANY of them. The canonical `labels.name` is the collapsed spelling the entity
 * carries; the raw `tracks.label` is whatever the release actually said, and for a row the crawler
 * minted before it had a canonical label to point at, it is the only one there is. A channel
 * matching either one is that label's channel.
 */
function recordingNames(existing: ExistingRow): { artists: string[]; labels: string[] } {
  const labels = [existing.label_name, existing.label]
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.trim());

  return { artists: parseArtistsJson(existing.artists_json ?? "[]"), labels };
}

export async function updateTrack(
  trackId: string,
  update: TrackUpdate,
  // The AUTHENTICATED caller's tier, lifted from the oRPC context by the handler —
  // NEVER read from the request body. Absent (internal server writes that never
  // touch bpm/key) leaves the provenance guard inert. `agent` writes are dropped on
  // a protected row; `operator` writes always win (and stamp their own source).
  options: { writer?: AdminRole } = {},
): Promise<TrackUpdateResult> {
  const db = await getDb();
  // Resolve from `tracks` with an OUTER join onto the certification, NOT through the
  // finding join. The audio pipeline must be able to write bpm/key/features/the vector
  // onto a CATALOGUE track (track-work.ts) — an inner join would make every such write
  // 404'd, which is the other half of the bug the split left behind. `certified` carries
  // the answer forward so the rail below can reject a certification field on a row that
  // has nowhere to put it.
  const existingResult = await db.execute({
    args: [trackId],
    // The `labels` join is for the officialness gate's third accepted class (a recording's own
    // label channel). It rides the indexed `tracks.label_id` → `labels.id` edge and is an OUTER
    // join, so a row with no canonical label resolves exactly as before and falls back to the raw
    // `tracks.label` string.
    sql: `select tracks.isrc, tracks.title, tracks.bpm_source, tracks.key_source,
                 tracks.artists_json, tracks.youtube_video_id, tracks.youtube_video_official,
                 tracks.label, labels.name as label_name,
                 findings.log_id, findings.added_at,
                 (findings.track_id is not null) as certified
          from tracks
          left join findings on findings.track_id = tracks.track_id
          left join labels on labels.id = tracks.label_id
          where tracks.track_id = ? limit 1`,
  });
  const existing = typedRow<ExistingRow>(existingResult.rows);

  if (!existing) {
    throw new ApiError("not_found", `No track with id ${trackId}`, 404);
  }

  // THE CERTIFICATION RAIL (see CERTIFICATION_FIELDS). A catalogue track may be measured
  // — never spoken about. Rejected LOUDLY, because the SQL would have failed silently:
  // `update findings … where track_id = ?` on a row with no finding matches zero rows and
  // reports success.
  const certified = Number(existing.certified) === 1;

  if (!certified) {
    const refused = (Object.keys(update) as Array<keyof TrackUpdate>)
      .filter((field) => CERTIFICATION_FIELDS.has(field))
      .sort();

    if (refused.length > 0) {
      throw new ApiError(
        "uncertified",
        `${trackId} is a catalogue track (no finding), so it cannot take the certification field${
          refused.length > 1 ? "s" : ""
        } ${refused.join(", ")}. Analysis fields (bpm, key, features, embedding, capture) are allowed; certifying a track is publish_track's job.`,
        409,
      );
    }
  }

  // Apply the source hierarchy before building the write (see PROTECTED_SOURCES).
  // The guard mutates the caller's fresh-per-request `update` object in place: it
  // either drops an agent's downgrading key/bpm fields, or stamps an operator's
  // hand-set value with the `operator` source so a later DSP pass can't clobber it.
  let guardDroppedFields = false;

  if (options.writer === "agent") {
    // An agent write of key (or its provenance) onto a rekordbox/operator-graded row
    // is a silent no-op for the KEY: drop key + keySource + keyConfidence, leave the
    // rest of the same update (bpm, features, status, analyzedFrom…) to apply.
    const writesKey =
      update.key !== undefined ||
      update.keySource !== undefined ||
      update.keyConfidence !== undefined;

    if (writesKey && existing.key_source && PROTECTED_SOURCES.has(existing.key_source)) {
      delete update.key;
      delete update.keySource;
      delete update.keyConfidence;
      guardDroppedFields = true;
    }

    // Symmetric for bpm.
    const writesBpm =
      update.bpm !== undefined ||
      update.bpmSource !== undefined ||
      update.bpmConfidence !== undefined;

    if (writesBpm && existing.bpm_source && PROTECTED_SOURCES.has(existing.bpm_source)) {
      delete update.bpm;
      delete update.bpmSource;
      delete update.bpmConfidence;
      guardDroppedFields = true;
    }
  } else if (options.writer === "operator") {
    // The operator always wins. A hand-set key/bpm with NO explicit source is stamped
    // `operator` server-side, so the value is durably protected from future DSP passes
    // (an explicit `--key-source rekordbox` on the backfill is left untouched).
    if (update.key !== undefined && update.keySource === undefined) {
      update.keySource = "operator";
    }

    if (update.bpm !== undefined && update.bpmSource === undefined) {
      update.bpmSource = "operator";
    }
  }

  // TWO SET-LISTS, one per half of the tracks/findings pair (docs/track-lifecycle.md).
  // `updateTrack` is one logical write across a supertype/subtype pair, so it fans out to
  // at most two statements: `sets`/`args` collect the columns on `tracks` (the recording —
  // analysis, embedding, capture, identity), `findingSets`/`findingArgs` the columns on
  // `findings` (the certification — coordinate, note, video, observation, status). The
  // allow-list, the guards, and the caller-visible `fields` result are unchanged; only the
  // routing is new. `updated_at` lives on `findings`, so the lastmod bump always rides the
  // certification statement.
  const sets: string[] = [];
  const args: Array<number | string | null> = [];
  const findingSets: string[] = [];
  const findingArgs: Array<number | string | null> = [];
  // The third statement, when the write carries a vector: the `track_embeddings` upsert or
  // delete that must travel in the SAME batch as its `has_embedding` half (embedding.ts).
  let embeddingStatement: InStatement | undefined;
  // The coordinate whose cached log surfaces this write stales: the existing one,
  // or the freshly-minted one on a one-time backfill (set below).
  let effectiveLogId = existing.log_id;

  const appendTempoAndKeyAnalysisFields = (): void => {
    if (update.bpm !== undefined) {
      sets.push("bpm = ?");
      args.push(update.bpm);
    }

    if (update.key !== undefined) {
      sets.push("key = ?");
      args.push(update.key);
    }

    // BPM/key analysis provenance (RFC bpm-key-accuracy). All internal analysis metadata —
    // NONE is in VISIBLE_FIELDS, so a provenance-only write bumps no public lastmod (mirrors
    // features/embedding). `analyzedFrom` is the field the capture re-derive predicate reads.
    if (update.bpmSource !== undefined) {
      sets.push("bpm_source = ?");
      args.push(update.bpmSource);
    }

    if (update.bpmConfidence !== undefined) {
      sets.push("bpm_confidence = ?");
      args.push(update.bpmConfidence);
    }

    if (update.keySource !== undefined) {
      sets.push("key_source = ?");
      args.push(update.keySource);
    }

    if (update.keyConfidence !== undefined) {
      sets.push("key_confidence = ?");
      args.push(update.keyConfidence);
    }

    if (update.analyzedFrom !== undefined) {
      sets.push("analyzed_from = ?");
      args.push(update.analyzedFrom);
    }

    if (update.analyzedAt !== undefined) {
      sets.push("analyzed_at = ?");
      args.push(update.analyzedAt);
    }
  };

  const appendVideoAndEnrichmentFields = (): void => {
    if (update.videoUrl !== undefined) {
      // Empty string clears the video (the "remove an off-direction video" path) —
      // null, not "", so the `video_url is not null` hasVideo filter drops it.
      findingSets.push("video_url = ?");
      findingArgs.push(update.videoUrl === "" ? null : update.videoUrl);
    }

    if (update.videoVehicle !== undefined) {
      findingSets.push("video_vehicle = ?");
      findingArgs.push(update.videoVehicle);
    }

    if (update.videoGrain !== undefined) {
      findingSets.push("video_grain = ?");
      findingArgs.push(update.videoGrain);
    }

    if (update.videoRegister !== undefined) {
      findingSets.push("video_register = ?");
      findingArgs.push(update.videoRegister);
    }

    if (update.videoPalette !== undefined) {
      findingSets.push("video_palette = ?");
      findingArgs.push(update.videoPalette);
    }

    if (update.videoPlateSubject !== undefined) {
      findingSets.push("video_plate_subject = ?");
      findingArgs.push(update.videoPlateSubject);
    }

    if (update.videoStructure !== undefined) {
      findingSets.push("video_structure = ?");
      findingArgs.push(update.videoStructure);
    }

    if (update.videoModel !== undefined) {
      findingSets.push("video_model = ?");
      findingArgs.push(update.videoModel);
    }

    if (update.videoModelReasoning !== undefined) {
      findingSets.push("video_model_reasoning = ?");
      findingArgs.push(update.videoModelReasoning);
    }

    if (update.videoSquaredAt !== undefined) {
      // Empty string clears the signal (back to the legacy single-file layout);
      // any value stamps the two-master layout. null, not "", so a cleared row is
      // treated as un-squared by the `video_squared_at is not null` reads.
      findingSets.push("video_squared_at = ?");
      findingArgs.push(update.videoSquaredAt === "" ? null : update.videoSquaredAt);
    }

    if (update.enrichmentStatus !== undefined) {
      findingSets.push("enrichment_status = ?");
      findingArgs.push(update.enrichmentStatus);
    }
  };

  const appendFeatureEmbeddingAndGalaxyFields = (): void => {
    if (update.features !== undefined) {
      sets.push("features_json = ?");
      args.push(update.features);
    }

    if (update.embedding !== undefined) {
      // The vector lands as a native `F32_BLOB(1024)` in the `track_embeddings` SATELLITE — the
      // ONLY stored form: every similarity read ranks `vector_distance_cos(…, ?)` in SQL against
      // that table, and `vector32()` converts the validated JSON server-side (the Worker never
      // encodes a vector). This is the sole writer, and it goes through embedding.ts's shared
      // statements so the satellite row and its `has_embedding` mirror provably cannot be
      // written apart (schema.ts § `has_embedding`).
      //
      // Empty string CLEARS it — a DELETE of the satellite row, because `vector32(NULL)` throws,
      // hence the two arms rather than one expression. The mirror drops to 0 in the same batch, so
      // the `has_embedding = 0` embed queue treats a cleared row as un-embedded (re-embed on the
      // next tick). `has_embedding` is a literal on both arms, never a bind: it is derived from
      // which arm we are on, never from caller input. The handler has already validated the 1024-d
      // shape (`coerceEmbedding`), so `vector32()` cannot see garbage.
      if (update.embedding === "") {
        sets.push(CLEAR_EMBEDDING_SQL);
        embeddingStatement = clearEmbeddingSatellite(trackId);
      } else {
        sets.push(SET_EMBEDDING_SQL);
        embeddingStatement = writeEmbeddingSatellite(trackId, update.embedding);
      }
    }

    if (update.galaxyId !== undefined) {
      // The nightly cluster assignment (browse-by-feel RFC). Empty string clears it —
      // null, not "", so `galaxy_id IS NULL` reads a cleared row as unassigned. NOT in
      // VISIBLE_FIELDS (below), so an assignment write bumps no public lastmod.
      findingSets.push("galaxy_id = ?");
      findingArgs.push(update.galaxyId === "" ? null : update.galaxyId);
    }
  };

  const appendCaptureStorageFields = (): void => {
    // The full-song capture side-channel (RFC full-audio). All internal analysis state
    // written by the `fluncle-capture` cron — NONE is in VISIBLE_FIELDS, so a capture
    // write bumps no public lastmod (mirrors the embedding/context discipline above).
    if (update.captureStatus !== undefined) {
      // THE RULING GUARD (docs/the-ear.md § Duplicates) — the same class of guarantee as the
      // auto-note's fill-empty-only rule: A MACHINE WRITE NEVER CLOBBERS AN OPERATOR RULING.
      // `duplicate-cleared` is the operator's sticky force-capture override, and the row it sits on
      // is EXPECTED to be captured — that is the whole point of the override — so the capture
      // sweep's terminal PATCH (`done`, or `failed`/`unmatched` on a bad day) would erase the
      // sentinel at exactly the moment it must survive: the very next post-embed re-rank would then
      // re-mark the row a duplicate, silently reversing the ruling right after the capture the
      // operator paid for. The CASE keeps the sentinel standing while every other capture column
      // (`sourceAudioKey`, the stamps, the failure count — the scheduling state the queue reads)
      // lands normally. Enforced HERE, server-side, rather than in the box sweep: the baked box
      // scripts freshen asynchronously after a deploy, so a box-side guard would leave a window
      // where an old sweep erases the sentinel — the Worker ships atomically with the deploy.
      // (The HTTP handler's enum admits only the four machine statuses, so no PATCH can write the
      // sentinel itself; the rank sweep's wrong-audio quarantine writes direct SQL and MAY overwrite
      // it — the verification gate deliberately outranks the duplicate override.)
      sets.push(
        "capture_status = case when capture_status = 'duplicate-cleared' then capture_status else ? end",
      );
      args.push(update.captureStatus);
    }

    if (update.sourceAudioKey !== undefined) {
      sets.push("source_audio_key = ?");
      args.push(update.sourceAudioKey);
    }

    if (update.captureVerification !== undefined) {
      sets.push("capture_verification = ?");
      args.push(update.captureVerification);
    }

    if (update.captureVerifiedAt !== undefined) {
      sets.push("capture_verified_at = ?");
      args.push(update.captureVerifiedAt);
    }

    if (update.sourceAudioRejected !== undefined) {
      // Empty string clears the memory — null, not "", so a cleared row reads as "no rejections yet".
      sets.push("source_audio_rejected = ?");
      args.push(update.sourceAudioRejected === "" ? null : update.sourceAudioRejected);
    }

    if (update.sourceAudioCapturedAt !== undefined) {
      sets.push("source_audio_captured_at = ?");
      args.push(update.sourceAudioCapturedAt);
    }

    if (update.sourceAudioAttemptedAt !== undefined) {
      sets.push("source_audio_attempted_at = ?");
      args.push(update.sourceAudioAttemptedAt);
    }

    if (update.sourceAudioFailures !== undefined) {
      sets.push("source_audio_failures = ?");
      args.push(update.sourceAudioFailures);
    }

    if (update.sourceAudioBytes !== undefined) {
      sets.push("source_audio_bytes = ?");
      args.push(update.sourceAudioBytes);
    }
  };

  // Preserve the field and bound-argument order: callers receive the SET-list order in `fields`,
  // and every placeholder must remain paired with the argument appended beside it.
  appendTempoAndKeyAnalysisFields();
  appendVideoAndEnrichmentFields();
  appendFeatureEmbeddingAndGalaxyFields();
  appendCaptureStorageFields();

  // SoundCloud evidence is a recording-side measurement. Narrow again at the write boundary so a
  // stale or direct caller cannot persist an invented verdict, and keep it entirely separate from
  // the YouTube-only id/verdict/stamp columns below.
  const askedSourceVerification = update.sourceVerification !== undefined;
  const askedYoutube =
    update.youtubeVideoId !== undefined ||
    update.youtubeVerification !== undefined ||
    update.youtubeReverdict !== undefined;
  const appendCaptureProvenanceFields = async (): Promise<void> => {
    const sourceVerification =
      update.sourceVerification === "soundcloud-preview-match" ||
      update.sourceVerification === "soundcloud-archive-match"
        ? update.sourceVerification
        : undefined;
    if (sourceVerification !== undefined) {
      sets.push("source_verification = ?");
      args.push(sourceVerification);
    }

    // THE CAPTURE'S YOUTUBE PROVENANCE (db/schema.ts § youtube_video_id). The sweep reports the id
    // of the upload its fingerprint gate accepted; the SERVER decides whether that upload may ever
    // be shown, and stamps when it decided. The box is never trusted with permission.
    //
    // FILL-EMPTY-ONLY, and ALL THREE COLUMNS MOVE TOGETHER OR NOT AT ALL. `coalesce` alone would be
    // wrong here in a way the Deezer trio never faces: `youtube_video_official` is legitimately NULL
    // (an unconcluded check) while the id beside it is set, so a coalesce on the verdict would let a
    // LATER capture's verdict attach itself to an EARLIER capture's id — a row claiming one upload is
    // official on the strength of a check run against a different one. The two `case` clauses read
    // the row's PRE-UPDATE `youtube_video_id` (SQLite evaluates every SET expression against the
    // original row), so the trio is atomically all-or-nothing: first write wins, provenance intact.
    //
    // AND THE ID IS ONLY TAKEN ALONGSIDE A REAL MATCH. Both proving sweeps have an ABSTAIN path —
    // a track with no preview reference compares nothing — and the envelope serves this id under
    // `method: "fingerprint"`. Accepting an id from that path would print "matched by audio
    // fingerprint" beneath a match that never ran. The sweeps already withhold it there; this is the
    // same condition enforced where a stale or wrong box build cannot reach, which is the rule the
    // whole leg is built on: the box reports, the server rules. It fails CLOSED — an id arriving
    // with NEITHER proof beside it is simply not stored.
    //
    // TWO PROOFS ARE ACCEPTED, and they are different claims about different writes:
    //
    //   · `captureVerification: "preview-match"` — the CAPTURE sweep, which is storing the very
    //     bytes it fingerprinted in this same body. Unchanged, so an old baked box build that knows
    //     nothing about the field below keeps working exactly as it did.
    //   · `youtubeVerification: "preview-match"` — the PROVENANCE backfill, which re-ran the same
    //     ladder over an already-captured row and threw the candidate bytes away. It has the proof
    //     and deliberately no capture write at all, so it cannot borrow capture's field: sending
    //     `captureVerification` from a sweep that stored nothing would be a lie about the archive.
    //
    // A BARE ID IS STILL REFUSED under both. The distinguishing fact is not who sent it — the server
    // has no way to know that — but whether the payload CARRIES a fingerprint verdict at all.
    // …AND EACH PROOF NAMES ITS OWN METHOD, which is the whole reason this is a map and not a
    // boolean. `youtube_verified_by` is served straight to the reader as the receipt's method
    // fragment, so the value chosen here IS the sentence the /identity page prints. A fingerprint
    // proof says "matched by audio fingerprint"; the Topic rung's metadata proof says "matched by
    // artist, title, and length" and must not be able to borrow the other. An UNKNOWN verdict maps to
    // nothing and so proves nothing — fail closed, exactly as a bare id does.
    const YOUTUBE_PROOF_METHODS: Partial<Record<YoutubeVerification, IdentityMethod>> = {
      "archive-match": "fingerprint",
      "metadata-match": "search",
      "preview-match": "fingerprint",
    };

    const provenanceMethod: IdentityMethod | undefined =
      update.captureVerification === "preview-match"
        ? "fingerprint"
        : typeof update.youtubeVerification === "string"
          ? YOUTUBE_PROOF_METHODS[update.youtubeVerification]
          : undefined;

    // Whether this body ASKED something of the YouTube trio. A declined ask — an id the row already
    // holds, a re-verdict on a row already ruled official, a bare id with no proof — must be a silent
    // NO-OP SUCCESS, never the `no_fields` 400: the provenance backfill's whole payload is these
    // fields, so a decline would otherwise read to the box as a failed write and a failed sweep. The
    // same reasoning the source-hierarchy guard above is built on.
    // `provenanceMethod !== undefined` IS the proof test — an unmapped verdict yields no method, and
    // narrowing on it here is what keeps `undefined` out of the bound args below.
    if (
      update.youtubeVideoId !== undefined &&
      provenanceMethod !== undefined &&
      !existing.youtube_video_id
    ) {
      // Skipped entirely when the row already holds an id — no oEmbed request is spent on an answer
      // the write would discard.
      const official = await checkYoutubeOfficial(update.youtubeVideoId, recordingNames(existing));

      sets.push(
        "youtube_video_id = coalesce(youtube_video_id, ?)",
        "youtube_video_official = case when youtube_video_id is null then ? else youtube_video_official end",
        "youtube_verified_at = case when youtube_video_id is null then ? else youtube_verified_at end",
        // THE METHOD RIDES THE SAME ALL-OR-NOTHING CASE as the verdict and the stamp, for the same
        // reason: a method that could attach itself to an EARLIER write's id would print the wrong
        // sentence under the right link, which is the one failure this receipt exists to prevent.
        "youtube_verified_by = case when youtube_video_id is null then ? else youtube_verified_by end",
      );
      args.push(update.youtubeVideoId, official, new Date().toISOString(), provenanceMethod);
    }

    // THE PROVENANCE SWEEP'S EMPTY-HANDED REPORT. The ladder ran, cost real proxy bandwidth, and
    // concluded that nothing on YouTube fingerprint-matches this recording. That is worth recording:
    // without it the worklist would hand the same row back on the very next tick and re-buy the same
    // download forever, which is the treadmill the anchor queue's re-ask window exists to prevent.
    //
    // ONE COLUMN MOVES, and it is not the id: `youtube_verified_at` becomes "when the provenance
    // question was last answered for this recording", answered NO. The id stays NULL, so a later
    // capture or a later backfill still fills it — the stamp is a schedule, never a verdict. Guarded
    // on the pre-update id anyway, so it can never disturb a row that already holds one.
    //
    // AND IT MOVES THE STREAK. The stamp alone paces a row that concluded honestly; it does nothing
    // for one that can NEVER conclude, and the worklist would go on offering that row every window
    // forever. `youtube_provenance_failures` is what retires it: the envelope never reads the column,
    // so a retired row's receipt honestly stays "Not checked yet" rather than acquiring a verdict it
    // did not earn; the streak guard applies here as well.
    //
    // `inconclusive` is the same streak WITHOUT the stamp. The catalogue ladder ran and the CDN
    // refused every section it tried; that is not an answer, so burning the 90-day window on it would
    // cost the row months for a reason that had nothing to do with the row. The streak still moves,
    // because a row that is refused forever must still stop being asked forever.
    const youtubeSettledNothing =
      (update.youtubeVerification === "no-match" ||
        update.youtubeVerification === "inconclusive") &&
      update.youtubeVideoId === undefined &&
      !existing.youtube_video_id;

    if (youtubeSettledNothing) {
      sets.push("youtube_provenance_failures = coalesce(youtube_provenance_failures, 0) + 1");
    }

    if (youtubeSettledNothing && update.youtubeVerification === "no-match") {
      sets.push(
        "youtube_verified_at = case when youtube_video_id is null then ? else youtube_verified_at end",
      );
      args.push(new Date().toISOString());
    }

    // THE RE-VERDICT. A row already holds an id whose officialness was ruled 0 (checked and refused)
    // or NULL (never concluded). The rule that ruled it has since WIDENED — a recording's own label
    // channel now counts — so the question is asked again, keylessly and for free.
    //
    // IT ONLY EVER PROMOTES. A row at 1 is excluded here as well as in the worklist: the widening is
    // the only reason to re-ask, and a channel rename must never quietly retract a link Fluncle has
    // been serving. The id is never touched, no capture column is touched, and an UNCONCLUDED check
    // (a 404, a timeout) leaves the verdict exactly as it was while still advancing the stamp — so
    // the round-robin moves on rather than spinning on an unreachable video.
    if (
      update.youtubeReverdict === true &&
      existing.youtube_video_id &&
      Number(existing.youtube_video_official) !== 1
    ) {
      const official = await checkYoutubeOfficial(
        existing.youtube_video_id,
        recordingNames(existing),
      );

      if (official !== null) {
        sets.push("youtube_video_official = ?");
        args.push(official);
      }

      sets.push("youtube_verified_at = ?");
      args.push(new Date().toISOString());
    }
  };

  await appendCaptureProvenanceFields();

  // THE PROVENANCE INVARIANT: a `*_prompt_version` column always describes the text
  // CURRENTLY in its row, or it is NULL. So rewriting the text through this generic path
  // (the operator typing a note by hand, an admin correction) CLEARS the version in the
  // same statement — otherwise the row would keep citing the prompt that wrote the note it
  // just replaced, which is worse than citing nothing: it is a confident wrong answer to
  // the one question the column exists to answer.
  //
  // A caller that KNOWS the provenance (the `note_track` / `observe_track` / `context_track`
  // paths, which author through a registry prompt) passes the version explicitly and it wins.
  // See lib/server/prompts.ts + docs/agents/prompt-registry.md.
  const appendEditorialFields = (): void => {
    if (update.note !== undefined) {
      findingSets.push("note = ?");
      findingArgs.push(update.note);

      if (update.notePromptVersion === undefined) {
        findingSets.push("note_prompt_version = ?");
        findingArgs.push(null);
      }
    }

    if (update.notePromptVersion !== undefined) {
      findingSets.push("note_prompt_version = ?");
      findingArgs.push(update.notePromptVersion);
    }

    if (update.contextNote !== undefined) {
      findingSets.push("context_note = ?");
      findingArgs.push(update.contextNote);

      // Same invariant as `note` above: a context note rewritten without a stated provenance
      // was written by no registry prompt, so the version must go with it.
      if (update.contextPromptVersion === undefined) {
        findingSets.push("context_prompt_version = ?");
        findingArgs.push(null);
      }
    }

    if (update.contextPromptVersion !== undefined) {
      findingSets.push("context_prompt_version = ?");
      findingArgs.push(update.contextPromptVersion);
    }

    if (update.contextStatus !== undefined) {
      findingSets.push("context_status = ?");
      findingArgs.push(update.contextStatus);
    }

    if (update.observationAlignmentJson !== undefined) {
      // Empty string clears it — null, not "", so the backfill's
      // `observation_alignment_json IS NULL` pick treats a cleared row as un-aligned.
      findingSets.push("observation_alignment_json = ?");
      findingArgs.push(
        update.observationAlignmentJson === "" ? null : update.observationAlignmentJson,
      );
    }

    if (update.observationAudioUrl !== undefined) {
      // Empty string clears the observation (re-render path) — null, not "", so the
      // `observation_audio_url is not null` radio-eligibility filter drops it.
      findingSets.push("observation_audio_url = ?");
      findingArgs.push(update.observationAudioUrl === "" ? null : update.observationAudioUrl);
    }

    if (update.observationDurationMs !== undefined) {
      findingSets.push("observation_duration_ms = ?");
      findingArgs.push(update.observationDurationMs);
    }

    if (update.observationGeneratedAt !== undefined) {
      findingSets.push("observation_generated_at = ?");
      findingArgs.push(update.observationGeneratedAt);
    }

    if (update.observationPromptVersion !== undefined) {
      findingSets.push("observation_prompt_version = ?");
      findingArgs.push(update.observationPromptVersion);
    }

    // Same invariant: an observation script rewritten with no stated provenance clears the
    // version rather than keeping one that describes the script it replaced.
    if (update.observationScript !== undefined && update.observationPromptVersion === undefined) {
      findingSets.push("observation_prompt_version = ?");
      findingArgs.push(null);
    }

    if (update.observationScript !== undefined) {
      // Empty string clears the transcript — null, not "", so a cleared row reads as
      // "no script yet" for the back-migration's `observation_script IS NULL` pick.
      findingSets.push("observation_script = ?");
      findingArgs.push(update.observationScript === "" ? null : update.observationScript);
    }
  };

  appendEditorialFields();

  const appendIdentityFields = async (): Promise<void> => {
    if (update.isrc !== undefined) {
      if (existing.isrc?.trim()) {
        throw new ApiError("immutable", "isrc is already set; identity fields never change", 409);
      }

      if (!update.isrc.trim()) {
        throw new ApiError("invalid_isrc", "isrc must be a non-empty string", 400);
      }

      sets.push("isrc = ?");
      args.push(update.isrc.trim());
      // The presence mirror rides the same statement (schema.ts § `has_isrc`); the guard above
      // makes the value non-empty, so this always writes 1 — spelled through the shared helper
      // so the pairing is uniform across writers.
      sets.push("has_isrc = ?");
      args.push(hasIsrc(update.isrc));
    }

    if (update.logId !== undefined) {
      if (existing.log_id?.trim()) {
        throw new ApiError("immutable", "log_id is already set; coordinates are permanent", 409);
      }

      let logId: string;

      // `logId` is a CERTIFICATION field, so the rail already 409'd an uncertified track and
      // a `findings` row is guaranteed here — which means `added_at` is non-null. Narrowed
      // with a guard rather than an assertion (the repo bans `!`); it is unreachable.
      const foundAt = existing.added_at;

      if (!foundAt) {
        throw new ApiError("not_found", `No finding for track ${trackId}`, 404);
      }

      if (update.logId === "auto") {
        // Backfill the coordinate the add flow would have minted: found date +
        // the recording's identity (the just-provided isrc wins over the stored
        // one, Spotify id as last resort).
        logId = await resolveLogId(
          {
            foundAt,
            isrc: update.isrc?.trim() || existing.isrc,
            trackId,
          },
          async (candidate) => {
            const taken = await db.execute({
              args: [candidate],
              sql: `select 1 from findings where log_id = ? limit 1`,
            });

            return taken.rows.length > 0;
          },
        );
      } else {
        if (!isLogId(update.logId)) {
          throw new ApiError(
            "invalid_log_id",
            `"${update.logId}" is not a Log ID coordinate (expected sector.orbit.mark, e.g. 004.7.2I, or "auto")`,
            400,
          );
        }

        const taken = await db.execute({
          args: [update.logId],
          sql: `select 1 from findings where log_id = ? limit 1`,
        });

        if (taken.rows.length > 0) {
          throw new ApiError("log_id_taken", `${update.logId} already names another finding`, 409);
        }

        logId = update.logId;
      }

      findingSets.push("log_id = ?");
      findingArgs.push(logId);
      effectiveLogId = logId;
    }
  };

  await appendIdentityFields();

  if (sets.length === 0 && findingSets.length === 0) {
    // The provenance guard dropped every field this write carried (an agent trying to
    // downgrade a rekordbox/operator-graded row with nothing else in the payload), or a
    // provenance ask was declined (a row that already holds a YouTube id, a re-verdict on a row
    // already ruled official, or an unknown source verdict): a silent no-op success, NOT a no_fields error — the
    // on-box sweeps must keep succeeding, and for the provenance backfill a decline is the
    // NORMAL outcome, not an error. A genuinely empty update is still the 400.
    if (guardDroppedFields || askedYoutube || askedSourceVerification) {
      return { fields: [], trackId };
    }

    throw new ApiError("no_fields", "No updatable fields provided", 400);
  }

  // Only bump updated_at (the sitemap/log lastmod source) when the write touches a
  // field that changes a PUBLIC surface. Internal training/fuel fields (features,
  // contextNote) move no visible surface, so they must not move lastmod — mirrors
  // the preview-archive precedent (internal writes don't bump). The observation
  // AUDIO is playable, so it counts as visible.
  const touchesVisible = (Object.keys(update) as Array<keyof TrackUpdate>).some((field) =>
    VISIBLE_FIELDS.has(field),
  );

  // `updated_at` is the CERTIFICATION's lastmod (a catalogue track has no /log page to
  // stale), so the bump always rides the `findings` statement — even when the visible
  // field that earned it (`bpm`, `isrc`) lives on `tracks`. Which is exactly why an
  // UNCERTIFIED track never bumps: it has no `findings` row to bump, and no public
  // surface that could have gone stale. Its `bpm` write is a measurement, not news.
  if (touchesVisible && certified) {
    findingSets.push("updated_at = ?");
    findingArgs.push(new Date().toISOString());
  }

  // Source statements come first, each fired only when its half actually has something to write;
  // the due/public maintenance statements follow in the same fixed list so every changes()-based
  // marker still reads the immediately preceding result. Non-embedding updates issue this list as
  // one transactional libSQL write batch. Embedding updates issue the same list as a batch
  // inside the explicit write transaction that appends the Sonar event below.
  //
  // THE VECTOR STATEMENT COMES AFTER THE TRACK UPDATE, and that ordering is load-bearing rather
  // than tidy: the clearing arm's DELETE is driven by the `has_embedding = 0` the `tracks` update
  // just wrote (embedding.ts § CLEAR_EMBEDDING_SATELLITE_SQL), so it must not run first. A track
  // with a vector but no mirror — or a mirror with no vector — is silent corruption of the
  // ranking, so the pair never leaves this list or its transaction.
  const statements = [
    ...(sets.length > 0
      ? [
          {
            args: [...args, trackId],
            sql: `update tracks set ${sets.join(", ")} where track_id = ?`,
          },
        ]
      : []),
    ...(update.isrc !== undefined
      ? [
          upsertTrackDuplicateKeyStatement({
            artistsJson: existing.artists_json ?? "[]",
            isrc: update.isrc.trim(),
            title: existing.title,
            trackId,
          }),
        ]
      : []),
    ...(findingSets.length > 0
      ? [
          {
            args: [...findingArgs, trackId],
            sql: `update findings set ${findingSets.join(", ")} where track_id = ?`,
          },
        ]
      : []),
    ...(embeddingStatement ? [embeddingStatement] : []),
    ...markDueWorkSourceMaintenanceStatements(
      [
        { subjectId: trackId, subjectType: "track" },
        ...(embeddingStatement
          ? [
              {
                subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
                subjectType: "track" as const,
              },
            ]
          : []),
      ],
      { producer: "track-update" },
    ),
  ];

  if (embeddingStatement === undefined) {
    // Preserve the existing low-round-trip batch for every non-embedding update. These writes do
    // not produce a sonar event because they do not accept or clear the vector that makes a track
    // visible in the index.
    await db.batch(statements, "write");
  } else {
    // Embedding visibility has one production chokepoint. Keep the existing statement list and
    // its changes()-dependent order intact inside an explicit write transaction, then re-read the
    // committed-shape Sonar source row and append exactly one event before the shared commit.
    const transaction = await db.transaction("write");

    try {
      await transaction.batch(statements);
      await insertCurrentSonarTrackArtifactChangeInTransaction(transaction, {
        producer: "track-update",
        trackId,
      });
      await transaction.commit();
    } catch (error) {
      try {
        await transaction.rollback();
      } catch {
        // Preserve the source/event failure. close() below is the final rollback/resource guard.
      }

      throw error;
    } finally {
      transaction.close();
    }
  }

  // The finding changed (enrichment, re-tag, video link, note edit, a backfilled
  // coordinate): drop its cached `/log/<id>` page + the `/log` index, and the entity
  // detail pages (artist/album/label) whose grids render this finding, so the next
  // request re-renders. Both fire-and-forget — never block the write.
  purgeLogCache(effectiveLogId);
  purgeTrackEntityPages(trackId);

  return {
    // The vector no longer moves as a `tracks` column, so it would drop out of a list derived
    // from the two SET-lists alone. Name it anyway — the caller asked to write an embedding and
    // is owed the same answer it got when the bytes lived on `tracks`.
    fields: [...sets, ...findingSets, ...(embeddingStatement ? ["embedding_blob"] : [])].map(
      (set) => set.split(" ")[0] ?? set,
    ),
    trackId,
  };
}

// THE FILL-EMPTY-ONLY GUARD, as a DB predicate — the race-safe note write. The
// auto-note agent's cardinal safety guarantee is that it NEVER overwrites an
// existing note ("the operator override always wins"). `updateTrack`'s note write
// is unconditional (correct for the operator, who may always overwrite); this is
// the AGENT-tier fill, where the guard must hold. The `and (note is null or
// trim(note) = '')` predicate lives in the SQL, not in JS, so an operator note
// written via `updateTrack` — or a second agent tick — that lands between the
// handler's read and this write can never lose the race and be clobbered: the
// loser matches no row and writes nothing. Mirrors the house pattern (submissions'
// `where … and status = 'pending'` claim, logbook's `on conflict … do nothing`).
//
// `note` is a VISIBLE field (it renders on the public `/log` page), so a fill bumps
// `updated_at` (the sitemap/log lastmod) in the SAME statement — atomically, so the
// bump happens iff the row was written. The edge-cache purge is likewise gated on a
// real write: a lost race wrote nothing, so there is nothing to refresh. The caller
// (the `note_track` handler) has already voice-gated + length-validated the note.
export async function fillEmptyNote(
  trackId: string,
  note: string,
  promptVersion?: number | null,
): Promise<boolean> {
  const db = await getDb();
  const existingResult = await db.execute({
    args: [trackId],
    sql: `select log_id from findings where track_id = ? limit 1`,
  });
  const existing = typedRow<{ log_id: string | null }>(existingResult.rows);

  if (!existing) {
    throw new ApiError("not_found", `No track with id ${trackId}`, 404);
  }

  // The note and its PROVENANCE land in the SAME atomic statement, so the version can
  // never describe a different note than the one it wrote (docs/agents/prompt-registry.md).
  // `promptVersion` is undefined for an operator-typed note and null when the sweep fell
  // back to its baked-in prompt — both store NULL, which reads as "no registry prompt
  // wrote this".
  const results = await db.batch(
    [
      {
        args: [note, promptVersion ?? null, new Date().toISOString(), trackId],
        sql: `update findings
                set note = ?, note_prompt_version = ?, updated_at = ?
              where track_id = ?
                and (note is null or trim(note) = '')`,
      },
      ...markDueWorkSourceMaintenanceStatements([{ subjectId: trackId, subjectType: "track" }], {
        onlyIfPreviousStatementChanged: true,
        producer: "track-note-fill",
      }),
    ],
    "write",
  );
  const result = results[0];

  const filled = (result?.rowsAffected ?? 0) > 0;

  if (filled) {
    // Only when the fill actually wrote: refresh the finding's cached `/log` page and the
    // entity pages whose grids show its note, so the new note surfaces. A lost race changed
    // nothing, so it must NOT purge.
    purgeLogCache(existing.log_id);
    purgeTrackEntityPages(trackId);
  }

  return filled;
}
