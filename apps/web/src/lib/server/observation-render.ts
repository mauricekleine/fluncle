// observation-render.ts — the render-and-store half of the observation pipeline, extracted
// from the observe_track handler so it has TWO callers: the handler (after its voice + echo
// gates) and the rejection ledger's `accepted` ruling (the operator overruling the echo gate
// on a held script). Both must render, upload, and persist identically — one definition.
//
// It does NOT gate. The voice gate and the echo gate live in the handler, BEFORE this runs,
// so a script reaching here has already cleared them (or is being deliberately overruled by
// the operator). This keeps the render path free of the anti-sameness policy: it renders what
// it is handed.

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

/** The tunable knobs the two callers pass through to a render. */
export type RenderObservationOptions = {
  /** An explicit factual context to author-render from; else the stored note, else a fetch. */
  contextNote?: string;
  /** An `ffprobe` override; absent, the length is derived from the render's word timestamps. */
  durationMs?: number;
  /** The 20–45s target (clamped 5–90); a last-resort duration when there is no alignment. */
  durationTargetSec: number;
  /** The prompt-registry version that authored this script (stamped as provenance). */
  promptVersion: number | null;
  /** Override the configured Cartesia voice id. */
  voiceId?: string;
};

/** The observe endpoint's success payload (shared so the handler + the ledger return one shape). */
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

/**
 * Render a gated observation script for a finding via Cartesia, upload the three R2 objects,
 * and persist the row (audio url + duration + timestamp + the script transcript + the alignment
 * + the prompt-version provenance). Requires a Log ID (the coordinate every artifact keys off).
 * The finding's `contextNote` is resolved in the same order the handler used it: an explicit
 * override, then the stored note, then a best-effort fetch (persisted only if freshly fetched).
 */
export async function renderAndStoreObservation(
  track: TrackListItem,
  script: string,
  options: RenderObservationOptions,
): Promise<RenderObservationResult> {
  const logId = track.logId;

  if (!logId) {
    throw new Error("renderAndStoreObservation requires a Log ID");
  }

  // Resolve the factual context: an explicit override, then the stored note, then a fetch.
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
