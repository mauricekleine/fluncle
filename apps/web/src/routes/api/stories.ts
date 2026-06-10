import { createFileRoute } from "@tanstack/react-router";
import { decodeTrackCursor, listTracks } from "../../lib/server/tracks";

// The Stories feed: findings that have a rendered video, newest first. A thin
// veneer over /api/tracks with the hasVideo filter baked in.
const defaultLimit = 16;
const maxLimit = 48;

export const Route = createFileRoute("/api/stories")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const limit = parseLimit(url.searchParams.get("limit"));
        const cursor = decodeTrackCursor(url.searchParams.get("cursor"));

        return Response.json(await listTracks({ cursor, hasVideo: true, limit }));
      },
    },
  },
});

function parseLimit(value: string | null): number {
  if (!value) {
    return defaultLimit;
  }

  const limit = Number.parseInt(value, 10);

  if (!Number.isInteger(limit) || limit < 1) {
    return defaultLimit;
  }

  return Math.min(limit, maxLimit);
}
