import { createFileRoute } from "@tanstack/react-router";
import { jsonError, requireAdmin } from "../../../lib/server/env";
import { publishTrack } from "../../../lib/server/publish";
import { ApiError } from "../../../lib/server/spotify";

type AddTrackBody = {
  spotifyUrl?: unknown;
  note?: unknown;
  dryRun?: unknown;
};

export const Route = createFileRoute("/api/admin/tracks")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        try {
          const body = (await request.json()) as AddTrackBody;

          if (typeof body.spotifyUrl !== "string") {
            return jsonError(400, "invalid_request", "Missing Spotify track URL");
          }

          const result = await publishTrack(body.spotifyUrl, {
            dryRun: body.dryRun === true,
            note: typeof body.note === "string" ? body.note : undefined,
          });

          return Response.json({
            ok: true,
            ...result,
          });
        } catch (error) {
          if (error instanceof ApiError) {
            return jsonError(error.status, error.code, error.message);
          }

          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
    },
  },
});
