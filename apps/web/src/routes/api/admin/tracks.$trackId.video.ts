import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { FOUND_BASE } from "../../../lib/media";
import { jsonError, requireAdmin } from "../../../lib/server/env";
import { getTrackByIdOrLogId } from "../../../lib/server/tracks";
import { updateTrack } from "../../../lib/server/track-update";

// FOUND_BASE (the R2 custom-domain read base) is shared from lib/media — the
// Worker owns the bucket; the agent uploads with the admin token, never holds R2
// credentials.

type Artifact = { contentType: string; field: string; name: string };

// The bundle the ship pipeline produces under out/<log-id>/. footage.mp4 is the
// canonical web cut (its URL becomes video_url); the rest are stored alongside.
// footage-silent.mp4 is the audio-less cut for manual TikTok sound-attach.
// cover.jpg is the profile-grid cover (operator sets it as the post cover);
// retrieved by convention at <log-id>/cover.jpg, no dedicated column.
// composition.tsx + props.json + render.json make the generated source
// re-renderable without keeping per-track compositions in the codebase.
const ARTIFACTS: Artifact[] = [
  { contentType: "video/mp4", field: "footage", name: "footage.mp4" },
  { contentType: "video/mp4", field: "footage-silent", name: "footage-silent.mp4" },
  { contentType: "image/jpeg", field: "poster", name: "poster.jpg" },
  { contentType: "image/jpeg", field: "cover", name: "cover.jpg" },
  { contentType: "text/plain; charset=utf-8", field: "note", name: "note.txt" },
  { contentType: "text/plain; charset=utf-8", field: "composition", name: "composition.tsx" },
  { contentType: "application/json; charset=utf-8", field: "props", name: "props.json" },
  { contentType: "application/json; charset=utf-8", field: "render", name: "render.json" },
];

// POST /api/admin/tracks/:idOrLogId/video — multipart upload of a track's video
// bundle. Stores each artifact at <log-id>/<name> in R2 and sets video_url to
// the review cut. Requires the track to have a Log ID (one identity everywhere).
export const Route = createFileRoute("/api/admin/tracks/$trackId/video")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        // .../tracks/<idOrLogId>/video — the id is the segment before "video".
        const parts = new URL(request.url).pathname.split("/").filter(Boolean);
        const idOrLogId = parts[parts.length - 2] ?? "";

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

          const form = await request.formData();
          const stored: Record<string, string> = {};
          // The travelling vehicle, read from the uploaded render.json (ship
          // writes it from `--vehicle`). Stored on the track as the diversity
          // ledger the next agent reads via /api/tracks.
          let videoVehicle: string | undefined;

          for (const artifact of ARTIFACTS) {
            const value = form.get(artifact.field);

            if (!(value instanceof File)) {
              continue;
            }

            const bytes = await value.arrayBuffer();
            const key = `${track.logId}/${artifact.name}`;
            await env.VIDEOS.put(key, bytes, {
              httpMetadata: { contentType: artifact.contentType },
            });
            stored[artifact.field] = `${FOUND_BASE}/${key}`;

            if (artifact.field === "render") {
              try {
                const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
                  vehicle?: unknown;
                };
                if (typeof manifest.vehicle === "string" && manifest.vehicle.trim()) {
                  videoVehicle = manifest.vehicle.trim().slice(0, 120);
                }
              } catch {
                // render.json is a loose manifest; a missing/unparseable vehicle
                // just leaves the ledger entry empty, never fails the upload.
              }
            }
          }

          if (!stored.footage) {
            return jsonError(400, "no_footage", "A `footage` cut (footage.mp4) is required");
          }

          // The footage (with-audio) cut is the canonical web video; the vehicle
          // (when present) joins it as the diversity-ledger entry.
          await updateTrack(track.trackId, {
            videoUrl: stored.footage,
            ...(videoVehicle ? { videoVehicle } : {}),
          });

          return Response.json({
            logId: track.logId,
            ok: true,
            trackId: track.trackId,
            urls: stored,
          });
        } catch (error) {
          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
    },
  },
});
