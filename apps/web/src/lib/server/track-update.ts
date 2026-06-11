// Generic admin track update — the write-back path for both the async enrichment
// agent and manual operator curation (see docs/track-lifecycle.md). Writes an
// ALLOW-LIST of curation/enrichment fields only; identity fields (title, artists,
// Spotify ids, Log ID) are immutable. Backs PATCH /api/admin/tracks/:id.

import { getDb } from "./db";
import { ApiError } from "./spotify";
import { normalizeTags } from "./tags";

export type TrackUpdate = {
  bpm?: number;
  enrichmentStatus?: "pending" | "done" | "failed";
  /** Raw audio feature vector as a JSON string (training data for the classifier). */
  features?: string;
  key?: string;
  note?: string;
  tags?: string[];
  /** Provenance for the tags write. Defaults to "manual" (the operator path). */
  tagsSource?: "auto" | "manual";
  videoUrl?: string;
  /** The video's travelling vehicle (diversity ledger; surfaced in /api/tracks). */
  videoVehicle?: string;
};

export type TrackUpdateResult = {
  fields: string[];
  trackId: string;
};

type ExistingRow = {
  tags_source: string | null;
};

export async function updateTrack(
  trackId: string,
  update: TrackUpdate,
): Promise<TrackUpdateResult> {
  const db = await getDb();
  const existingResult = await db.execute({
    args: [trackId],
    sql: `select tags_source from tracks where track_id = ? limit 1`,
  });
  const existing = existingResult.rows[0] as unknown as ExistingRow | undefined;

  if (!existing) {
    throw new ApiError("not_found", `No track with id ${trackId}`, 404);
  }

  const provided =
    update.tags !== undefined ||
    update.bpm !== undefined ||
    update.key !== undefined ||
    update.videoUrl !== undefined ||
    update.enrichmentStatus !== undefined ||
    update.features !== undefined ||
    update.note !== undefined ||
    update.videoVehicle !== undefined;

  if (!provided) {
    throw new ApiError("no_fields", "No updatable fields provided", 400);
  }

  const sets: string[] = [];
  const args: Array<number | string | null> = [];

  if (update.tags !== undefined) {
    const source = update.tagsSource ?? "manual";

    // Manual wins: an "auto" write (the agent) never clobbers admin-curated tags.
    if (source === "auto" && existing.tags_source === "manual") {
      // skip the tag write entirely
    } else {
      const cleaned = normalizeTags(update.tags);
      sets.push("tags_json = ?", "tags_source = ?");
      args.push(cleaned.length > 0 ? JSON.stringify(cleaned) : null, source);
    }
  }

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

  // sets can be empty when an "auto" tag write was declined by manual-wins —
  // that's a valid no-op, not an error.
  if (sets.length > 0) {
    args.push(trackId);
    await db.execute({
      args,
      sql: `update tracks set ${sets.join(", ")} where track_id = ?`,
    });
  }

  return { fields: sets.map((set) => set.split(" ")[0]), trackId };
}
