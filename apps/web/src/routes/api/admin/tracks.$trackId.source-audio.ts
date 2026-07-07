import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { type ApiHandlers, aliasHandlers } from "../-alias";
import { jsonError, requireOperator } from "../../../lib/server/env";
import { apiErrorResponse, requireParam } from "../../../lib/server/http-errors";
import { getSourceAudioKey } from "../../../lib/server/tracks";

// GET /api/admin/tracks/:idOrLogId/source-audio (verb_noun `get_source_audio`) —
// stream a finding's captured FULL SONG from the PRIVATE `fluncle-source-audio` R2
// bucket. This is a private analysis artifact (never world-served, unlike the
// found.fluncle.com video/preview surfaces), so:
//   * `requireOperator` — stricter than the sibling preview GET's agent-tier
//     `requireAdmin`. The full copyrighted master is only ever read by the M5
//     live-visuals bridge, which carries the OPERATOR token; the box's own capture/
//     enrich/embed sweeps read the bytes over direct-S3, never through this route.
//   * R2 credentials stay Worker-side (the `SOURCE_AUDIO` binding); the caller only
//     holds the admin token.
// A same-origin media-proxy carve-out, modeled on `tracks.$trackId.silent-clip.ts`
// (stream `object.body` straight through with re-clothed headers).

// The captured container varies with what `yt-dlp -f bestaudio` returns (webm/opus,
// m4a/mp4, mp3, ogg, aac), so derive the Content-Type from the key's extension when
// the stored object carries none. Not a playback surface — a decode source for the
// bridge's ffmpeg — so an unknown extension safely falls to octet-stream.
const AUDIO_CONTENT_TYPES: Record<string, string> = {
  aac: "audio/aac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  mp4: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/opus",
  webm: "audio/webm",
};

function contentTypeForKey(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";

  return AUDIO_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export const serverHandlers: ApiHandlers = {
  GET: async ({ params, request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    const idOrLogId = requireParam(params.trackId, "trackId");

    try {
      const key = await getSourceAudioKey(idOrLogId);

      if (!key) {
        return jsonError(
          404,
          "source_audio_uncaptured",
          "This finding has no captured full song yet",
        );
      }

      const object = await env.SOURCE_AUDIO.get(key);

      if (!object) {
        // The key is recorded but the object is gone — treat as uncaptured (the
        // bridge's never-crash rail reads any non-OK as null frames and nudges past).
        return jsonError(404, "source_audio_missing", "The captured full song is no longer in R2");
      }

      // Stream the bytes straight through (no buffering). `writeHttpMetadata` carries
      // the stored Content-Type when the capture set one; otherwise derive it from
      // the key extension. Content-Length is known, so set it for the bridge fetch.
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", contentTypeForKey(key));
      }
      headers.set("Content-Length", String(object.size));
      headers.set("Cache-Control", "no-store");

      return new Response(object.body, { headers });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/tracks/$trackId/source-audio")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
