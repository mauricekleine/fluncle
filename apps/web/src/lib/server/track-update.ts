import { type TrackUpdateResult } from "@fluncle/contracts";

export type { TrackUpdateResult };

// Generic admin track update — the write-back path for both the async enrichment
// agent and manual operator curation (see docs/track-lifecycle.md). Writes an
// ALLOW-LIST of curation/enrichment fields only; identity fields (title, artists,
// Spotify ids, Log ID) are immutable once set — isrc/logId accept a one-time
// backfill into a null slot (the ISRC-fallback straggler repair), never a
// change. Backs PATCH /api/admin/tracks/:id.

import { isLogId } from "../log-id";
import { getDb, typedRow } from "./db";
import { purgeLogCache } from "./edge-cache";
import { resolveLogId } from "./log-id";
import { ApiError } from "./spotify";

export type TrackUpdate = {
  bpm?: number;
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
  enrichmentStatus?: "pending" | "processing" | "done" | "failed";
  /** Raw audio feature vector as a JSON string (training data for the classifier). */
  features?: string;
  /** One-time backfill into a null isrc slot; rejected when one is already set. */
  isrc?: string;
  key?: string;
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
  /** The AI model that authored the video, in <provider>/<model> notation. */
  videoModel?: string;
  /** The reasoning/thinking effort the authoring model ran at (e.g. "high"). */
  videoModelReasoning?: string;
  /**
   * The two-master layout signal (docs/video-variants.md): an ISO timestamp set
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
  "videoSquaredAt",
  "videoUrl",
  "videoVehicle",
  "vibeX",
  "vibeY",
]);

type ExistingRow = {
  added_at: string;
  isrc: string | null;
  log_id: string | null;
};

export async function updateTrack(
  trackId: string,
  update: TrackUpdate,
): Promise<TrackUpdateResult> {
  const db = await getDb();
  const existingResult = await db.execute({
    args: [trackId],
    sql: `select isrc, log_id, added_at from tracks where track_id = ? limit 1`,
  });
  const existing = typedRow<ExistingRow>(existingResult.rows);

  if (!existing) {
    throw new ApiError("not_found", `No track with id ${trackId}`, 404);
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
