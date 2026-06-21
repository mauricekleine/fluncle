import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { env } from "cloudflare:workers";

import { FOUND_BASE, trackMedia } from "../../../lib/media";
import { jsonError, requireOperator } from "../../../lib/server/env";
import {
  apiErrorResponse,
  noLogIdResponse,
  trackNotFoundResponse,
} from "../../../lib/server/http-errors";
import {
  DEFAULT_OBSERVATION_MODEL,
  DEFAULT_VOICE_SETTINGS,
  type ObservationArtifact,
  type ObservationModel,
  type ObservationVoiceSettings,
  fetchTrackContext,
  gateObservationScript,
  renderObservation,
  resolveVoiceId,
} from "../../../lib/server/observation";
import { getTrackByIdOrLogId } from "../../../lib/server/tracks";
import { updateTrack } from "../../../lib/server/track-update";

// POST /api/admin/tracks/:idOrLogId/observe — mint the audio-observation artifact
// (the third enrichment artifact; see docs/agents/observation-agent.md). The
// agent authors the script (it holds copywriting-fluncle) and posts it here; the
// Worker fetches the factual context (firecrawl), VOICE-GATES the script,
// renders it (ElevenLabs), uploads observation.{mp3,txt,json} to R2 at
// <log-id>/<name>, and writes context_note + observation_* back. The Worker holds
// every vendor secret; the agent only ever carries its admin token.
//
// Auto-allowed in the command gate (it writes an internal R2 artifact + private
// field + enrichment fields, posts to NO public feed) — but it spends an
// ElevenLabs render per call, so callers should de-dupe per log id (one render
// per track). Requires a Log ID (the R2 key) like the video flow.

type ObserveBody = {
  contextNote?: unknown;
  durationMs?: unknown;
  durationTargetSec?: unknown;
  model?: unknown;
  script?: unknown;
  voiceId?: unknown;
  voiceSettings?: unknown;
};

function resolveModel(value: unknown): ObservationModel {
  return value === "eleven_v3" || value === "eleven_multilingual_v2"
    ? value
    : DEFAULT_OBSERVATION_MODEL;
}

function resolveVoiceSettings(value: unknown): ObservationVoiceSettings {
  if (typeof value !== "object" || value === null) {
    return DEFAULT_VOICE_SETTINGS;
  }

  const raw = value as Record<string, unknown>;
  const num = (key: keyof ObservationVoiceSettings, fallback: number): number =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : fallback;

  return {
    similarityBoost: num("similarityBoost", DEFAULT_VOICE_SETTINGS.similarityBoost),
    speed: num("speed", DEFAULT_VOICE_SETTINGS.speed),
    stability: num("stability", DEFAULT_VOICE_SETTINGS.stability),
    style: num("style", DEFAULT_VOICE_SETTINGS.style),
  };
}

function resolveDurationTargetSec(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 5 && value <= 90) {
    return Math.round(value);
  }

  return 30;
}

export const serverHandlers: ApiHandlers = {
  POST: async ({ params, request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    const idOrLogId = params.trackId;

    try {
      const track = await getTrackByIdOrLogId(idOrLogId);

      if (!track) {
        return trackNotFoundResponse(idOrLogId);
      }

      if (!track.logId) {
        return noLogIdResponse();
      }

      const body = (await request.json().catch(() => undefined)) as ObserveBody | undefined;

      if (!body) {
        return jsonError(400, "invalid_request", "Malformed JSON body");
      }

      // The agent authors + voice-gates the script; the Worker re-runs the
      // mechanical scan (defence in depth) and hard-fails on any violation.
      const script = gateObservationScript(body.script);
      const model = resolveModel(body.model);
      const voiceSettings = resolveVoiceSettings(body.voiceSettings);
      const durationTargetSec = resolveDurationTargetSec(body.durationTargetSec);
      const voiceId = await resolveVoiceId(
        typeof body.voiceId === "string" ? body.voiceId : undefined,
      );

      // The factual context (firecrawl). The agent may pass its own context_note;
      // otherwise the Worker fetches it. Either way it is INTERNAL fuel.
      const artist = track.artists.join(" ");
      const fetched =
        typeof body.contextNote === "string"
          ? { contextNote: body.contextNote.trim().slice(0, 2000), sources: [] as string[] }
          : await fetchTrackContext(
              [artist, track.title, track.label, track.releaseDate, "drum and bass"]
                .filter(Boolean)
                .join(" "),
            );

      // Render the spoken observation (ElevenLabs).
      const { bytes } = await renderObservation(voiceId, { model, text: script, voiceSettings });

      // Duration: ElevenLabs doesn't return one and the Worker can't probe (no
      // ffprobe). The agent passes the ffprobe value; absent it, estimate from the
      // target with a noted ±budget. The radio page never re-probes.
      const durationMs =
        typeof body.durationMs === "number" &&
        Number.isFinite(body.durationMs) &&
        body.durationMs > 0
          ? Math.round(body.durationMs)
          : durationTargetSec * 1000;

      const media = trackMedia(track.logId);
      const generatedAt = new Date().toISOString();

      const artifact: ObservationArtifact = {
        audioUrl: media.observationAudioUrl,
        ...(fetched.contextNote ? { contextNote: fetched.contextNote } : {}),
        durationMs,
        durationTargetSec,
        generatedAt,
        logId: track.logId,
        model,
        provider: "elevenlabs",
        ...(fetched.sources.length > 0 ? { sources: fetched.sources } : {}),
        text: script,
        textUrl: media.observationTextUrl,
        trackId: track.trackId,
        voiceId,
        voiceSettings,
      };

      // Upload the three R2 objects at <log-id>/<name> (the Worker holds the
      // ≈0.5 MB bytes — direct put, no presign needed for a small artifact).
      const base = encodeURIComponent(track.logId);
      await env.VIDEOS.put(`${track.logId}/observation.mp3`, bytes, {
        httpMetadata: { contentType: "audio/mpeg" },
      });
      await env.VIDEOS.put(`${track.logId}/observation.txt`, script, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      });
      await env.VIDEOS.put(`${track.logId}/observation.json`, JSON.stringify(artifact, null, 2), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });

      // Persist: the audio url (the "has observation" flag) + duration + timestamp
      // (visible — they bump lastmod) and the context note (internal — it doesn't).
      await updateTrack(track.trackId, {
        observationAudioUrl: media.observationAudioUrl,
        observationDurationMs: durationMs,
        observationGeneratedAt: generatedAt,
        ...(fetched.contextNote ? { contextNote: fetched.contextNote } : {}),
      });

      return Response.json({
        audioUrl: media.observationAudioUrl,
        durationMs,
        generatedAt,
        jsonUrl: `${FOUND_BASE}/${base}/observation.json`,
        logId: track.logId,
        ok: true,
        textUrl: media.observationTextUrl,
        trackId: track.trackId,
        voiceId,
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/tracks/$trackId/observe")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
