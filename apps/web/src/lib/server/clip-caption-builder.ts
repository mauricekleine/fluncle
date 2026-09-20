// Build a clip caption from stored prose and recording cues. A promoted recording uses
// its mixtape coordinate; otherwise covered findings contribute their coordinates. When
// no finding overlaps, credit the covered tracks by artist and title. An uncued window
// adds no credit to avoid misattribution. The clip service and caption lookup share this builder.

import { type ClipDTO } from "@fluncle/contracts/orpc";
import { type ClipTrackInput, resolveClipTracks } from "@fluncle/contracts/util";
import { getDb, typedRows } from "./db";
import { type CueRow, getRecording, getRecordingCues } from "./recordings";

/** A built clip caption: the clean caption, the coordinate line(s), and the two joined. */
export type BuiltClipCaption = {
  /** The clean caption + the coordinate line(s), ready to copy/post. */
  builtCaption: string;
  /** The stored-clean caption (no coordinate), if any. */
  caption?: string;
  clipId: string;
  /** The `fluncle://<logId>` line(s) — one per covered finding, or the promoted mixtape's. */
  coordinates: string[];
};

// The Log ID for each of these findings (trackIds), for the published ones only
// (a draft/un-published finding has no `log_id`). Keyed by trackId.
async function logIdsForFindings(trackIds: string[]): Promise<Map<string, string>> {
  const byTrack = new Map<string, string>();

  if (trackIds.length === 0) {
    return byTrack;
  }

  const db = await getDb();
  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: trackIds,
    sql: `select track_id, log_id from findings
          where track_id in (${placeholders}) and log_id is not null`,
  });

  for (const row of typedRows<{ log_id: string; track_id: string }>(result.rows)) {
    byTrack.set(row.track_id, row.log_id);
  }

  return byTrack;
}

// Map a recording's cues into the `resolveClipTracks` member shape, carrying each
// cue's finding Log ID (when it is a published finding) so the resolver can hand back
// the covered coordinates. The cue stores `artists_text` as one ", "-joined string;
// `ClipTrackInput.artists` is a string[], so split at the caption boundary.
function cuesToMembers(cues: CueRow[], logIdByFinding: Map<string, string>): ClipTrackInput[] {
  return cues.map((cue) => ({
    artists: cue.artists_text ? cue.artists_text.split(", ") : [],
    logId: cue.finding_id ? logIdByFinding.get(cue.finding_id) : undefined,
    startMs: cue.start_ms ?? undefined,
    title: cue.title_text ?? "",
  }));
}

/** What a clip's window credits: the `fluncle://` coordinate line(s), else the covered
 *  tracks' labels when the window resolves to cues but none of them is a finding. The two
 *  are mutually exclusive — a coordinate is the stronger credit and wins whenever it exists. */
type ClipCredit = {
  /** The `fluncle://<logId>` line(s) — one per covered finding, or the promoted mixtape's. */
  coordinates: string[];
  /** The covered tracks' `Artist — Title` labels, only when `coordinates` is empty. */
  trackLines: string[];
};

const NO_CREDIT: ClipCredit = { coordinates: [], trackLines: [] };

// The credit line(s) for a clip: the promoted mixtape's Log ID if its source recording is
// published, else the covered findings' coordinates, else the covered tracks' labels.
// Deduped in play order (a set can play the same track twice → one line).
async function clipCredit(clip: ClipDTO): Promise<ClipCredit> {
  if (clip.recordingId) {
    const recording = await getRecording(clip.recordingId);

    // A published recording uses its mixtape coordinate.
    if (recording.logId) {
      return { coordinates: [`fluncle://${recording.logId}`], trackLines: [] };
    }

    // Un-promoted: link every FINDING the clip window overlaps (a blend = multiple lines).
    const cues = await getRecordingCues(clip.recordingId);
    const findingIds = cues
      .map((cue) => cue.finding_id)
      .filter((value): value is string => value !== null);
    const logIdByFinding = await logIdsForFindings(findingIds);
    const resolved = resolveClipTracks({
      inMs: clip.inMs,
      members: cuesToMembers(cues, logIdByFinding),
      outMs: clip.outMs,
      // Guard the nullable set duration (RFC S7): `undefined` → 0, and the resolver's
      // `Math.max(setDurationMs, outMs)` still clamps the last cue's interval to `outMs`.
      setDurationMs: recording.durationMs ?? 0,
    });

    const seenLogIds = new Set<string>();
    const coordinates: string[] = [];

    for (const track of resolved) {
      if (track.logId && !seenLogIds.has(track.logId)) {
        seenLogIds.add(track.logId);
        coordinates.push(`fluncle://${track.logId}`);
      }
    }

    if (coordinates.length > 0) {
      return { coordinates, trackLines: [] };
    }

    // No coordinate to emit. If the window still covers cued tracks, credit them by label
    // rather than posting a clip that names nobody (the cue-label fallback above).
    const seenLabels = new Set<string>();
    const trackLines: string[] = [];

    for (const track of resolved) {
      if (track.label && !seenLabels.has(track.label)) {
        seenLabels.add(track.label);
        trackLines.push(track.label);
      }
    }

    return { coordinates, trackLines };
  }

  // An unlinked clip has no recording cues to credit.
  return NO_CREDIT;
}

// Join the clean caption + the credit line(s): a blank line separates prose from the
// credit; either half alone renders on its own.
function composeCaption(caption: string | undefined, credit: ClipCredit): string {
  const clean = caption?.trim() ?? "";
  const lines = [...credit.coordinates, ...credit.trackLines].join("\n");

  if (!lines) {
    return clean;
  }

  return clean ? `${clean}\n\n${lines}` : lines;
}

/** Build the caption for a fetched clip, preserving coordinate and cue-label precedence. */
export async function buildCaptionForClip(clip: ClipDTO): Promise<BuiltClipCaption> {
  const credit = await clipCredit(clip);

  return {
    builtCaption: composeCaption(clip.caption, credit),
    caption: clip.caption,
    clipId: clip.id,
    coordinates: credit.coordinates,
  };
}
