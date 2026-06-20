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

export const serverHandlers = Route.options.server!.handlers;
