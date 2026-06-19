import { createFileRoute } from "@tanstack/react-router";
import { NOTE_MAX_LENGTH } from "../../../lib/log-prose";
import { jsonError, requireAdmin } from "../../../lib/server/env";
import { publishTrack } from "../../../lib/server/publish";
import { triggerEnrichment } from "../../../lib/server/spinup";
import { ApiError } from "../../../lib/server/spotify";
import { decodeTrackCursor, listTracks, searchTracks } from "../../../lib/server/tracks";

type AddTrackBody = {
  spotifyUrl?: unknown;
  note?: unknown;
  dryRun?: unknown;
};

// Admin list page size mirrors the public /api/tracks cap (48) — callers page
// through with the cursor rather than asking for a huge single fetch.
const adminDefaultLimit = 16;
const adminMaxLimit = 48;

export const Route = createFileRoute("/api/admin/tracks")({
  server: {
    handlers: {
      // Admin-only archive query: the same listTracks the web app uses, but with
      // order + hasVideo exposed so the CLI can ask the DB directly for "oldest
      // finding without a video" (the render queue) or "recent finding WITH a
      // video" (the vehicle ledger). Filtering happens in SQL, not client-side.
      GET: async ({ request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        const url = new URL(request.url);

        // Free-text search path: an admin UI looks a finding up by Log ID,
        // track ID, title, or artist. Returns the same TrackListItem shape, just
        // without the cursor/totalCount envelope (search is a flat result set).
        const q = url.searchParams.get("q")?.trim();

        if (q) {
          return Response.json({
            tracks: await searchTracks({
              limit: parseAdminLimit(url.searchParams.get("limit")),
              q,
            }),
          });
        }

        return Response.json(
          await listTracks({
            cursor: decodeTrackCursor(url.searchParams.get("cursor")),
            hasVideo: parseBoolean(url.searchParams.get("hasVideo")),
            limit: parseAdminLimit(url.searchParams.get("limit")),
            order: url.searchParams.get("order") === "asc" ? "asc" : "desc",
          }),
        );
      },
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

          // The note rides into the Telegram post AND the stored editorial note,
          // so cap it here on the add path too — same 280 budget as the PATCH.
          let note: string | undefined;
          if (typeof body.note === "string") {
            const trimmed = body.note.trim();

            if (trimmed.length > NOTE_MAX_LENGTH) {
              return jsonError(
                422,
                "note_too_long",
                `Note must be ${NOTE_MAX_LENGTH} characters or less`,
              );
            }

            note = trimmed || undefined;
          }

          const result = await publishTrack(body.spotifyUrl, {
            dryRun: body.dryRun === true,
            note,
          });

          // Kick off async enrichment on Spinup — a fast enqueue (the work runs
          // durably on Spinup, not in the Worker). triggerEnrichment never throws.
          if (!result.dryRun && result.track.logId) {
            await triggerEnrichment(result.track.trackId, result.track.logId);
          }

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

// `hasVideo` is tri-state: "true" → only findings with a video, "false" → only
// those without, absent → no video filter.
function parseBoolean(value: string | null): boolean | undefined {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}

function parseAdminLimit(value: string | null): number {
  if (!value) {
    return adminDefaultLimit;
  }

  const limit = Number.parseInt(value, 10);

  if (!Number.isInteger(limit) || limit < 1) {
    return adminDefaultLimit;
  }

  return Math.min(limit, adminMaxLimit);
}
