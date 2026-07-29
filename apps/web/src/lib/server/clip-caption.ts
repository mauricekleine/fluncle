// The clip caption builder (RFC plan→recording→mixtape §5). A clip's `caption` is
// stored CLEAN — no coordinate. This builds the caption for a surface (the clip-card
// copy button; the box's cut payload later) by APPENDING the `fluncle://` coordinate
// line(s):
//   - the clip's source recording is PUBLISHED (promoted to a mixtape) → one line, the
//     mixtape's `.F.` Log ID (the whole set is one coordinate now);
//   - else → one line per FINDING the clip window overlaps, derived honestly from the
//     recording's `recording_cues` via `resolveClipTracks` (a blend = multiple lines;
//     a window over no cued finding = no coordinate — honest silence beats
//     misattribution, RFC §5).
// The coordinate is FROZEN into the stored caption at publish (a later slice); this
// module is the derivation both that freeze and the live card read share.
//
// THE CUE-LABEL FALLBACK. A window can overlap cues that are all NON-findings (a dubplate,
// a white label, anything Fluncle never certified). Those cues carry no Log ID, so there is
// no coordinate to emit — but `resolveClipTracks` already hands back each covered track's
// `Artist — Title` label, and throwing that away meant the clip went out crediting nobody.
// So when the window resolves to tracks and NONE of them is a finding, the caption credits
// what is playing by its label instead. Data-led, no authored prose: the sanctioned
// `Artist — Title` separator and nothing else. A window that resolves to NO cue at all
// (an un-cued recording) still builds an empty caption — honest silence, and the drip
// tick refuses to post it (see `drip_clips`).

import { type ClipDTO } from "@fluncle/contracts/orpc";
import { type ClipTrackInput, resolveClipTracks } from "@fluncle/contracts/util";
import { getClip } from "./clips";
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
// `ClipTrackInput.artists` is a string[], so split at the boundary (RFC §5, the N-8 shim).
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

    // Published: the whole set is one coordinate now — one line, the mixtape's `.F.` id.
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

  // A clip with no recording is unlinked (the legacy `mixtape_id` owner was dropped
  // in the plan→recording→mixtape Deploy-2 cutover — every legacy clip was repointed
  // onto its mixtape's recording first). Nothing to link.
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

/**
 * Build a clip's caption for display/copy — the clean caption with the `fluncle://`
 * coordinate line(s) appended, or the covered tracks' labels when the window covers cues
 * that are not findings (RFC §5 + the cue-label fallback above). Throws
 * `clip_not_found`/404 when the clip is gone (via `getClip`).
 */
export async function buildClipCaption(clipId: string): Promise<BuiltClipCaption> {
  const clip = await getClip(clipId);
  const credit = await clipCredit(clip);

  return {
    builtCaption: composeCaption(clip.caption, credit),
    caption: clip.caption,
    clipId,
    coordinates: credit.coordinates,
  };
}
