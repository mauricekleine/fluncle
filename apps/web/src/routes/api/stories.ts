import { createFileRoute } from "@tanstack/react-router";
import { parseLimit } from "../../lib/server/query-params";
import { type ApiHandlers, aliasHandlers } from "./-alias";
import { decodeTrackCursor, listTracks } from "../../lib/server/tracks";

// The Stories feed: findings that have a rendered video, newest first. A thin
// veneer over /api/tracks with the hasVideo filter baked in.
const defaultLimit = 16;
const maxLimit = 48;

export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"), defaultLimit, maxLimit);
    const cursor = decodeTrackCursor(url.searchParams.get("cursor"));

    return Response.json(await listTracks({ cursor, hasVideo: true, limit }));
  },
};

export const Route = createFileRoute("/api/stories")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
