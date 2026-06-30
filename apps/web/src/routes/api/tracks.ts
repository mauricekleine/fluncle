import { createFileRoute } from "@tanstack/react-router";
import { parseLimit } from "../../lib/server/query-params";
import { decodeTrackCursor, listTracks } from "../../lib/server/tracks";
import { type ApiHandlers, aliasHandlers } from "./-alias";

const defaultLimit = 16;
const maxLimit = 48;

export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"), defaultLimit, maxLimit);
    const cursor = decodeTrackCursor(url.searchParams.get("cursor"));
    const since = parseTimestamp(url.searchParams.get("since"));
    const until = parseTimestamp(url.searchParams.get("until"));

    return Response.json(
      await listTracks({
        cursor,
        includeMixtapes: since === undefined && until === undefined,
        limit,
        since,
        until,
      }),
    );
  },
};

export const Route = createFileRoute("/api/tracks")({
  server: { handlers: aliasHandlers(serverHandlers) },
});

// Discovery-window bound as an ISO 8601 timestamp; invalid values are ignored
// rather than erroring so a malformed query degrades to the unwindowed list.
// Normalized to ISO so string comparison against stored added_at is correct.
function parseTimestamp(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}
