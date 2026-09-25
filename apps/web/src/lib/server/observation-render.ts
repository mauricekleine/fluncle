import { env } from "cloudflare:workers";
import { FOUND_BASE, trackMedia } from "../media";
import {
  buildContextQuery,
  DEFAULT_CARTESIA_EMOTION,
  DEFAULT_CARTESIA_SPEED,
  fetchTrackContext,
  type ObservationArtifact,
  observationDurationFromAlignment,
  renderObservationCartesia,
  resolveCartesiaVoiceId,
} from "./observation";
import { getTrackContextNote } from "./tracks";
import { type TrackListItem } from "./tracks";
import { updateTrack } from "./track-update";

export type RenderObservationOptions = {
  contextNote?: string;

  durationMs?: number;

  durationTargetSec: number;

  promptVersion: number | null;

  voiceId?: string;
};

export type RenderObservationResult = {
  audioUrl: string;
  durationMs: number;
  generatedAt: string;
  jsonUrl: string;
  logId: string;
  textUrl: string;
  trackId: string;
  voiceId: string;
};

export async function renderAndStoreObservation(
  track: TrackListItem,
  script: string,
  options: RenderObservationOptions,
): Promise<RenderObservationResult> {
  const logId = track.logId;

  if (!logId) {
    throw new Error("renderAndStoreObservation requires a Log ID");
  }

  const storedContextNote = await getTrackContextNote(track.trackId);
  let contextNote = "";
  let freshlyFetched = false;

  if (typeof options.contextNote === "string" && options.contextNote.trim()) {
    contextNote = options.contextNote.trim().slice(0, 2000);
  } else if (storedContextNote?.trim()) {
    contextNote = storedContextNote.trim().slice(0, 2000);
  } else {
    const fetched = await fetchTrackContext(
      buildContextQuery(track),
      { logId, trackId: track.trackId },
      { isrc: track.isrc },
    );
    contextNote = fetched.contextNote;
    freshlyFetched = Boolean(fetched.contextNote);
  }

  const cartesiaVoiceId = await resolveCartesiaVoiceId(options.voiceId);
  const { alignment, bytes, voiceId } = await renderObservationCartesia(cartesiaVoiceId, {
    capture: { logId, trackId: track.trackId },
    text: script,
  });

  const durationMs =
    typeof options.durationMs === "number" &&
    Number.isFinite(options.durationMs) &&
    options.durationMs > 0
      ? Math.round(options.durationMs)
      : (observationDurationFromAlignment(alignment) ?? options.durationTargetSec * 1000);

  const media = trackMedia(logId);
  const generatedAt = new Date().toISOString();

  const artifact: ObservationArtifact = {
    ...(alignment ? { alignment } : {}),
    audioUrl: media.observationAudioUrl,
    ...(contextNote ? { contextNote } : {}),
    durationMs,
    durationTargetSec: options.durationTargetSec,
    emotion: DEFAULT_CARTESIA_EMOTION,
    generatedAt,
    logId,
    provider: "cartesia",
    speed: DEFAULT_CARTESIA_SPEED,
    text: script,
    textUrl: media.observationTextUrl,
    trackId: track.trackId,
    voiceId,
  };

  const base = encodeURIComponent(logId);

  await Promise.all([
    env.VIDEOS.put(`${logId}/observation.mp3`, bytes, {
      httpMetadata: { contentType: "audio/mpeg" },
    }),
    env.VIDEOS.put(`${logId}/observation.txt`, script, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    }),
    env.VIDEOS.put(`${logId}/observation.json`, JSON.stringify(artifact, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    }),
  ]);

  await updateTrack(track.trackId, {
    ...(alignment ? { observationAlignmentJson: JSON.stringify(alignment) } : {}),
    observationAudioUrl: media.observationAudioUrl,
    observationDurationMs: durationMs,
    observationGeneratedAt: generatedAt,
    observationPromptVersion: options.promptVersion,
    observationScript: script,
    ...(freshlyFetched ? { contextNote, contextStatus: "resolved" as const } : {}),
  });

  return {
    audioUrl: media.observationAudioUrl,
    durationMs,
    generatedAt,
    jsonUrl: `${FOUND_BASE}/${base}/observation.json`,
    logId,
    textUrl: media.observationTextUrl,
    trackId: track.trackId,
    voiceId,
  };
}
