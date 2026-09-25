import { type ClipDTO } from "@fluncle/contracts/orpc";
import { type ClipTrackInput, resolveClipTracks } from "@fluncle/contracts/util";
import { getDb, typedRows } from "./db";
import { type CueRow, getRecording, getRecordingCues } from "./recordings";

export type BuiltClipCaption = {
  builtCaption: string;

  caption?: string;
  clipId: string;

  coordinates: string[];
};

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

function cuesToMembers(cues: CueRow[], logIdByFinding: Map<string, string>): ClipTrackInput[] {
  return cues.map((cue) => ({
    artists: cue.artists_text ? cue.artists_text.split(", ") : [],
    logId: cue.finding_id ? logIdByFinding.get(cue.finding_id) : undefined,
    startMs: cue.start_ms ?? undefined,
    title: cue.title_text ?? "",
  }));
}

type ClipCredit = {
  coordinates: string[];

  trackLines: string[];
};

const NO_CREDIT: ClipCredit = { coordinates: [], trackLines: [] };

async function clipCredit(clip: ClipDTO): Promise<ClipCredit> {
  if (clip.recordingId) {
    const recording = await getRecording(clip.recordingId);

    if (recording.logId) {
      return { coordinates: [`fluncle://${recording.logId}`], trackLines: [] };
    }

    const cues = await getRecordingCues(clip.recordingId);
    const findingIds = cues
      .map((cue) => cue.finding_id)
      .filter((value): value is string => value !== null);
    const logIdByFinding = await logIdsForFindings(findingIds);
    const resolved = resolveClipTracks({
      inMs: clip.inMs,
      members: cuesToMembers(cues, logIdByFinding),
      outMs: clip.outMs,

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

  return NO_CREDIT;
}

function composeCaption(caption: string | undefined, credit: ClipCredit): string {
  const clean = caption?.trim() ?? "";
  const lines = [...credit.coordinates, ...credit.trackLines].join("\n");

  if (!lines) {
    return clean;
  }

  return clean ? `${clean}\n\n${lines}` : lines;
}

export async function buildCaptionForClip(clip: ClipDTO): Promise<BuiltClipCaption> {
  const credit = await clipCredit(clip);

  return {
    builtCaption: composeCaption(clip.caption, credit),
    caption: clip.caption,
    clipId: clip.id,
    coordinates: credit.coordinates,
  };
}
