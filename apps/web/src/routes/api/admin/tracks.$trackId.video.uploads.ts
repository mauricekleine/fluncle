import { createFileRoute } from "@tanstack/react-router";

import { jsonError, requireAdmin } from "../../../lib/server/env";
import { VIDEOS_BUCKET, presignUploads } from "../../../lib/server/r2-presign";
import { getTrackByIdOrLogId } from "../../../lib/server/tracks";
import { artifactByField } from "../../../lib/server/video-bundle";

// POST /api/admin/tracks/:idOrLogId/video/uploads — phase 1 of the presigned
// direct-to-R2 upload flow. The CLI lists which artifact fields it has; the
// Worker signs one short-lived PUT URL per field (keyed at <log-id>/<name>,
// Content-Type baked into the signature) and returns them. The bytes then go
// straight to R2's S3 endpoint, bypassing Cloudflare's ~100MB edge body limit.
//
// The Worker owns the R2 credentials; the CLI only ever holds the admin token +
// these expiring URLs. Requires the track to have a Log ID (one identity).
export const Route = createFileRoute("/api/admin/tracks/$trackId/video/uploads")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        // .../tracks/<idOrLogId>/video/uploads — id is two segments before the tail.
        const parts = new URL(request.url).pathname.split("/").filter(Boolean);
        const idOrLogId = parts[parts.length - 3] ?? "";

        try {
          const track = await getTrackByIdOrLogId(idOrLogId);

          if (!track) {
            return jsonError(404, "not_found", `No track with id ${idOrLogId}`);
          }

          if (!track.logId) {
            return jsonError(
              400,
              "no_log_id",
              "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
            );
          }

          const body = (await request.json().catch(() => undefined)) as
            | { fields?: unknown }
            | undefined;
          const requested = Array.isArray(body?.fields) ? body.fields : undefined;

          if (!requested || requested.length === 0) {
            return jsonError(400, "no_fields", "List the artifact `fields` you want to upload");
          }

          const artifacts = [];

          for (const field of requested) {
            if (typeof field !== "string") {
              return jsonError(400, "bad_field", "Each field must be a string");
            }

            const artifact = artifactByField(field);

            if (!artifact) {
              return jsonError(400, "unknown_field", `Unknown video artifact field: ${field}`);
            }

            artifacts.push(artifact);
          }

          if (!artifacts.some((artifact) => artifact.field === "footage")) {
            return jsonError(400, "no_footage", "A `footage` cut (footage.mp4) is required");
          }

          const signed = await presignUploads(
            VIDEOS_BUCKET,
            artifacts.map((artifact) => ({
              contentType: artifact.contentType,
              key: `${track.logId}/${artifact.name}`,
            })),
          );

          const uploads = artifacts.map((artifact, index) => ({
            contentType: signed[index].contentType,
            field: artifact.field,
            key: signed[index].key,
            url: signed[index].url,
          }));

          return Response.json({ logId: track.logId, ok: true, trackId: track.trackId, uploads });
        } catch (error) {
          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
    },
  },
});
