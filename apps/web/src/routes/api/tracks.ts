import { createFileRoute } from "@tanstack/react-router";
import { decodeTrackCursor, listTracks } from "../../lib/server/tracks";

const defaultLimit = 16;
const maxLimit = 48;

export const Route = createFileRoute("/api/tracks")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const limit = parseLimit(url.searchParams.get("limit"));
        const cursor = decodeTrackCursor(url.searchParams.get("cursor"));

        return Response.json(await listTracks({ cursor, limit }));
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
