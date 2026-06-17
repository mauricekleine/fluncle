import { createFileRoute } from "@tanstack/react-router";
import { getRandomTrack } from "../../../lib/server/tracks";

export const Route = createFileRoute("/api/tracks/random")({
  server: {
    handlers: {
      GET: async () => {
        const track = await getRandomTrack();

        if (!track) {
          return Response.json(
            {
              code: "track_not_found",
              message: "No tracks found",
              ok: false,
            },
            { status: 404 },
          );
        }

        return Response.json({ ok: true, track });
      },
    },
  },
});
