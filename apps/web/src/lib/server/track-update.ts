import { type TrackUpdateResult } from "@fluncle/contracts";

export type { TrackUpdateResult };

// Generic admin track update — the write-back path for both the async enrichment
// agent and manual operator curation. Writes an
// ALLOW-LIST of curation/enrichment fields only; identity fields (title, artists,
// Spotify ids, Log ID) are immutable once set — isrc/logId accept a one-time
// backfill into a null slot (the ISRC-fallback straggler repair), never a
// change. Backs PATCH /api/admin/tracks/:id.

import { isLogId } from "../log-id";
import { getDb, typedRow } from "./db";
import { purgeLogCache } from "./edge-cache";
import { type AdminRole } from "./env";
import { resolveLogId } from "./log-id";
import { ApiError } from "./spotify";

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
   * lastmod. `captureStatus` is the enum (pending|done|unmatched|failed);
   * `sourceAudioKey` is the R2 key of the captured song (presence = captured);
   * `sourceAudioCapturedAt`/`sourceAudioAttemptedAt` are ISO stamps; `sourceAudioFailures`
   * is the consecutive-failure count driving the backoff window. See schema.ts.
   */
  captureStatus?: "pending" | "done" | "unmatched" | "failed";
  /**
   * Firecrawl-derived FACTUAL context (creative fuel for the observation script
   * + video agent). Internal only — never on /log, never in JSON-LD/RSS. Writing
   * it alone does NOT bump updated_at (it moves no public surface).
   */
  contextNote?: string;
  /**
   * The context-fetch reliability marker (the `context_track` queue's resume state).
   * Internal only — never surfaced through public DTOs, and (like contextNote)
   * writing it does NOT bump updated_at. See schema.ts `contextStatus`.
   */
  contextStatus?: "pending" | "resolved" | "empty" | "failed";
  /**
   * The finding's MuQ audio embedding as a JSON array of 1024 floats (the
   * `embedding_json` column). Internal analysis fuel like `features` — written by the
   * on-box `fluncle-embed` cron, never rendered, so writing it does NOT bump
   * updated_at (a whole-archive embed backfill must move no public lastmod). It IS the
   * sonic-similarity space `get_similar_findings` ranks over; the handler validates the
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
  "videoRegister",
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
  "contextStatus",
  "enrichmentStatus",
  "galaxyId",
  "logId",
  "note",
  "observationAlignmentJson",
  "observationAudioUrl",
  "observationDurationMs",
  "observationGeneratedAt",
  "observationScript",
  "videoGrain",
  "videoModel",
  "videoModelReasoning",
  "videoRegister",
  "videoSquaredAt",
  "videoUrl",
  "videoVehicle",
]);

type ExistingRow = {
  added_at: string | null;
  bpm_source: string | null;
  // 1 when a `findings` row exists — i.e. the track is a FINDING, not a catalogue row.
  certified: number;
  isrc: string | null;
  key_source: string | null;
  log_id: string | null;
};

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
  // onto a CATALOGUE track (track-work.ts) — under the old inner join every such write
  // 404'd, which is the other half of the bug the split left behind. `certified` carries
  // the answer forward so the rail below can reject a certification field on a row that
  // has nowhere to put it.
  const existingResult = await db.execute({
    args: [trackId],
    sql: `select tracks.isrc, tracks.bpm_source, tracks.key_source,
                 findings.log_id, findings.added_at,
                 (findings.track_id is not null) as certified
          from tracks
          left join findings on findings.track_id = tracks.track_id
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
  // The coordinate whose cached log surfaces this write stales: the existing one,
  // or the freshly-minted one on a one-time backfill (set below).
  let effectiveLogId = existing.log_id;

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

  if (update.features !== undefined) {
    sets.push("features_json = ?");
    args.push(update.features);
  }

  if (update.embedding !== undefined) {
    // THE DUAL WRITE. The vector lands in BOTH forms, in one statement: the JSON array
    // (the source of truth) and the native `F32_BLOB(1024)` the similarity reads rank
    // against in SQL (`vector32()` converts it server-side, so the Worker never encodes
    // a vector). Writing only the JSON would make a finding invisible to "more like
    // this" until the next deploy's backfill caught it.
    //
    // Empty string CLEARS both — null, not "", so the `embedding_json IS NULL` embed
    // queue treats a cleared row as un-embedded (re-embed on the next tick), and no
    // orphan blob outlives the vector it came from. `vector32(NULL)` throws, hence the
    // two arms rather than one clever expression. The handler has already validated the
    // 1024-d shape (`coerceEmbedding`), so `vector32()` cannot see garbage here.
    if (update.embedding === "") {
      sets.push("embedding_json = ?", "embedding_blob = ?");
      args.push(null, null);
    } else {
      sets.push("embedding_json = ?", "embedding_blob = vector32(?)");
      args.push(update.embedding, update.embedding);
    }
  }

  if (update.galaxyId !== undefined) {
    // The nightly cluster assignment (browse-by-feel RFC). Empty string clears it —
    // null, not "", so `galaxy_id IS NULL` reads a cleared row as unassigned. NOT in
    // VISIBLE_FIELDS (below), so an assignment write bumps no public lastmod.
    findingSets.push("galaxy_id = ?");
    findingArgs.push(update.galaxyId === "" ? null : update.galaxyId);
  }

  // The full-song capture side-channel (RFC full-audio). All internal analysis state
  // written by the `fluncle-capture` cron — NONE is in VISIBLE_FIELDS, so a capture
  // write bumps no public lastmod (mirrors the embedding/context discipline above).
  if (update.captureStatus !== undefined) {
    sets.push("capture_status = ?");
    args.push(update.captureStatus);
  }

  if (update.sourceAudioKey !== undefined) {
    sets.push("source_audio_key = ?");
    args.push(update.sourceAudioKey);
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

  if (update.note !== undefined) {
    findingSets.push("note = ?");
    findingArgs.push(update.note);
  }

  if (update.contextNote !== undefined) {
    findingSets.push("context_note = ?");
    findingArgs.push(update.contextNote);
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

  if (update.observationScript !== undefined) {
    // Empty string clears the transcript — null, not "", so a cleared row reads as
    // "no script yet" for the back-migration's `observation_script IS NULL` pick.
    findingSets.push("observation_script = ?");
    findingArgs.push(update.observationScript === "" ? null : update.observationScript);
  }

  if (update.isrc !== undefined) {
    if (existing.isrc?.trim()) {
      throw new ApiError("immutable", "isrc is already set; identity fields never change", 409);
    }

    if (!update.isrc.trim()) {
      throw new ApiError("invalid_isrc", "isrc must be a non-empty string", 400);
    }

    sets.push("isrc = ?");
    args.push(update.isrc.trim());
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

  if (sets.length === 0 && findingSets.length === 0) {
    // The provenance guard dropped every field this write carried (an agent trying to
    // downgrade a rekordbox/operator-graded row with nothing else in the payload): a
    // silent no-op success, NOT a no_fields error — the on-box sweeps must keep
    // succeeding. A genuinely empty update (no guard drop) is still the 400.
    if (guardDroppedFields) {
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

  // At most two statements, each fired only when its half actually has columns to write.
  // They are issued as one libSQL BATCH, so a partial write is impossible: the pair moves
  // together or not at all (the transactional guarantee the single UPDATE used to give for
  // free). `write` batches are transactional in libSQL.
  const statements = [
    ...(sets.length > 0
      ? [
          {
            args: [...args, trackId],
            sql: `update tracks set ${sets.join(", ")} where track_id = ?`,
          },
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
  ];

  await db.batch(statements, "write");

  // The finding changed (enrichment, re-tag, video link, note edit, a backfilled
  // coordinate): drop its cached `/log/<id>` page + the `/log` index so the next
  // request re-renders. Fire-and-forget — never blocks the write.
  purgeLogCache(effectiveLogId);

  return {
    fields: [...sets, ...findingSets].map((set) => set.split(" ")[0] ?? set),
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
export async function fillEmptyNote(trackId: string, note: string): Promise<boolean> {
  const db = await getDb();
  const existingResult = await db.execute({
    args: [trackId],
    sql: `select log_id from findings where track_id = ? limit 1`,
  });
  const existing = typedRow<{ log_id: string | null }>(existingResult.rows);

  if (!existing) {
    throw new ApiError("not_found", `No track with id ${trackId}`, 404);
  }

  const result = await db.execute({
    args: [note, new Date().toISOString(), trackId],
    sql: `update findings
            set note = ?, updated_at = ?
          where track_id = ?
            and (note is null or trim(note) = '')`,
  });

  const filled = result.rowsAffected > 0;

  if (filled) {
    // Only when the fill actually wrote: refresh the finding's cached `/log` page so
    // the new note surfaces. A lost race changed nothing, so it must NOT purge.
    purgeLogCache(existing.log_id);
  }

  return filled;
}
