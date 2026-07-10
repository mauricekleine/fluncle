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
  /** Vibe-map placement (the admin tagging tool). vibeX = Light↔Dark mood. */
  vibeX?: number;
  /** vibeY = Floaty↔Driving energy. Both set together when a track is placed. */
  vibeY?: number;
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
  "vibeX",
  "vibeY",
]);

// SOURCE HIERARCHY — operator > rekordbox > DSP. An agent (DSP) write NEVER
// downgrades a value a human or Rekordbox graded. `bpm_source`/`key_source` record
// who last set each value; the DSP key/BPM estimator is weaker than a DJ-graded
// Rekordbox key (documented mode/relative-key confusion), so letting an agent-tier
// enrichment overwrite a `rekordbox`/`operator` value is a REGRESSION, not an
// upgrade. These are the sources an agent may not clobber.
const PROTECTED_SOURCES = new Set(["operator", "rekordbox"]);

type ExistingRow = {
  added_at: string;
  bpm_source: string | null;
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
  const existingResult = await db.execute({
    args: [trackId],
    sql: `select isrc, log_id, added_at, bpm_source, key_source from tracks where track_id = ? limit 1`,
  });
  const existing = typedRow<ExistingRow>(existingResult.rows);

  if (!existing) {
    throw new ApiError("not_found", `No track with id ${trackId}`, 404);
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

  const sets: string[] = [];
  const args: Array<number | string | null> = [];
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
    sets.push("video_url = ?");
    args.push(update.videoUrl === "" ? null : update.videoUrl);
  }

  if (update.videoVehicle !== undefined) {
    sets.push("video_vehicle = ?");
    args.push(update.videoVehicle);
  }

  if (update.videoGrain !== undefined) {
    sets.push("video_grain = ?");
    args.push(update.videoGrain);
  }

  if (update.videoRegister !== undefined) {
    sets.push("video_register = ?");
    args.push(update.videoRegister);
  }

  if (update.videoModel !== undefined) {
    sets.push("video_model = ?");
    args.push(update.videoModel);
  }

  if (update.videoModelReasoning !== undefined) {
    sets.push("video_model_reasoning = ?");
    args.push(update.videoModelReasoning);
  }

  if (update.videoSquaredAt !== undefined) {
    // Empty string clears the signal (back to the legacy single-file layout);
    // any value stamps the two-master layout. null, not "", so a cleared row is
    // treated as un-squared by the `video_squared_at is not null` reads.
    sets.push("video_squared_at = ?");
    args.push(update.videoSquaredAt === "" ? null : update.videoSquaredAt);
  }

  if (update.enrichmentStatus !== undefined) {
    sets.push("enrichment_status = ?");
    args.push(update.enrichmentStatus);
  }

  if (update.features !== undefined) {
    sets.push("features_json = ?");
    args.push(update.features);
  }

  if (update.embedding !== undefined) {
    // Empty string clears the vector — null, not "", so the `embedding_json IS NULL`
    // embed queue treats a cleared row as un-embedded (re-embed on the next tick).
    sets.push("embedding_json = ?");
    args.push(update.embedding === "" ? null : update.embedding);
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

  if (update.note !== undefined) {
    sets.push("note = ?");
    args.push(update.note);
  }

  if (update.contextNote !== undefined) {
    sets.push("context_note = ?");
    args.push(update.contextNote);
  }

  if (update.contextStatus !== undefined) {
    sets.push("context_status = ?");
    args.push(update.contextStatus);
  }

  if (update.observationAlignmentJson !== undefined) {
    // Empty string clears it — null, not "", so the backfill's
    // `observation_alignment_json IS NULL` pick treats a cleared row as un-aligned.
    sets.push("observation_alignment_json = ?");
    args.push(update.observationAlignmentJson === "" ? null : update.observationAlignmentJson);
  }

  if (update.observationAudioUrl !== undefined) {
    // Empty string clears the observation (re-render path) — null, not "", so the
    // `observation_audio_url is not null` radio-eligibility filter drops it.
    sets.push("observation_audio_url = ?");
    args.push(update.observationAudioUrl === "" ? null : update.observationAudioUrl);
  }

  if (update.observationDurationMs !== undefined) {
    sets.push("observation_duration_ms = ?");
    args.push(update.observationDurationMs);
  }

  if (update.observationGeneratedAt !== undefined) {
    sets.push("observation_generated_at = ?");
    args.push(update.observationGeneratedAt);
  }

  if (update.observationScript !== undefined) {
    // Empty string clears the transcript — null, not "", so a cleared row reads as
    // "no script yet" for the back-migration's `observation_script IS NULL` pick.
    sets.push("observation_script = ?");
    args.push(update.observationScript === "" ? null : update.observationScript);
  }

  if (update.vibeX !== undefined) {
    sets.push("vibe_x = ?");
    args.push(update.vibeX);
  }

  if (update.vibeY !== undefined) {
    sets.push("vibe_y = ?");
    args.push(update.vibeY);
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

    if (update.logId === "auto") {
      // Backfill the coordinate the add flow would have minted: found date +
      // the recording's identity (the just-provided isrc wins over the stored
      // one, Spotify id as last resort).
      logId = await resolveLogId(
        {
          foundAt: existing.added_at,
          isrc: update.isrc?.trim() || existing.isrc,
          trackId,
        },
        async (candidate) => {
          const taken = await db.execute({
            args: [candidate],
            sql: `select 1 from tracks where log_id = ? limit 1`,
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
        sql: `select 1 from tracks where log_id = ? limit 1`,
      });

      if (taken.rows.length > 0) {
        throw new ApiError("log_id_taken", `${update.logId} already names another finding`, 409);
      }

      logId = update.logId;
    }

    sets.push("log_id = ?");
    args.push(logId);
    effectiveLogId = logId;
  }

  if (sets.length === 0) {
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

  if (touchesVisible) {
    sets.push("updated_at = ?");
    args.push(new Date().toISOString());
  }

  args.push(trackId);
  await db.execute({
    args,
    sql: `update tracks set ${sets.join(", ")} where track_id = ?`,
  });

  // The finding changed (enrichment, re-tag, video link, note edit, a backfilled
  // coordinate): drop its cached `/log/<id>` page + the `/log` index so the next
  // request re-renders. Fire-and-forget — never blocks the write.
  purgeLogCache(effectiveLogId);

  return { fields: sets.map((set) => set.split(" ")[0] ?? set), trackId };
}
