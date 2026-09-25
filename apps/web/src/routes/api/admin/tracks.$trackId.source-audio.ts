import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { type ApiHandlers, aliasHandlers } from "../-alias";
import { jsonError, requireOperator } from "../../../lib/server/env";
import { apiErrorResponse, requireParam } from "../../../lib/server/http-errors";
import { getSourceAudioKey } from "../../../lib/server/tracks";

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
        return jsonError(404, "source_audio_missing", "The captured full song is no longer in R2");
      }

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
