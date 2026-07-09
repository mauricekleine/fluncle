import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { type ApiHandlers, aliasHandlers } from "../-alias";
import { jsonError, requireAdmin } from "../../../lib/server/env";
import { apiErrorResponse, requireParam } from "../../../lib/server/http-errors";
import { getPreviewArchiveMetadata } from "../../../lib/server/preview-archive";

// GET /api/admin/tracks/:idOrLogId/preview-audio (verb_noun `get_preview_audio`) —
// stream a finding's ARCHIVED 30s official preview bytes back through the Worker so
// they are never publicly reachable. This is a copyright-sensitive analysis artifact
// (a licensed Deezer/iTunes preview kept for model training), so:
//   * `requireAdmin` — AGENT tier, mirroring the sibling preview GET metadata read
//     (`tracks.$trackId.preview.ts`) and the agent-tier media proxy
//     `tracks.$trackId.silent-clip.ts`. The autonomous render box reads its OWN
//     finding's preview audio with its AGENT-scoped token; `requireOperator` would
//     401 the renderer and break video rendering.
//   * R2 credentials stay Worker-side; the caller only holds the admin token.
// A same-origin media-proxy carve-out, modeled on `tracks.$trackId.source-audio.ts`
// (stream `object.body` straight through with re-clothed headers).

export const serverHandlers: ApiHandlers = {
  GET: async ({ params, request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    const idOrLogId = requireParam(params.trackId, "trackId");

    try {
      const archive = await getPreviewArchiveMetadata(idOrLogId);

      if (!archive) {
        return jsonError(404, "track_not_found", `No finding matches "${idOrLogId}"`);
      }

      if (!archive.key) {
        return jsonError(
          404,
          "preview_unarchived",
          "This finding has no archived preview audio yet",
        );
      }

      // Every archived preview now lives in the PRIVATE `fluncle-source-audio` bucket
      // (binding SOURCE_AUDIO) at `<logId>/preview.<ext>` — REF-05 migrated the legacy
      // public `analysis/previews/…` objects off the world-served `fluncle-videos`
      // bucket and swept the prefix empty. A hypothetical stale `analysis/previews/…`
      // key simply misses here and falls through to the `preview_audio_missing` 404.
      const object = await env.SOURCE_AUDIO.get(archive.key);

      if (!object) {
        return jsonError(
          404,
          "preview_audio_missing",
          "The archived preview audio is no longer in R2",
        );
      }

      // Stream the bytes straight through (no buffering). Prefer the stored MIME the
      // archive recorded; otherwise let `writeHttpMetadata` carry R2's own
      // Content-Type. Content-Length is known, so set it for the box fetch.
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      if (archive.mime) {
        headers.set("Content-Type", archive.mime);
      }
      headers.set("Content-Length", String(object.size));
      headers.set("Cache-Control", "no-store");

      return new Response(object.body, { headers });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/tracks/$trackId/preview-audio")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
