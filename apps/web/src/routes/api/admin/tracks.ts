import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { jsonError, requireAdmin, requireOperator } from "../../../lib/server/env";
import { apiErrorResponse, parseEditorialNote } from "../../../lib/server/http-errors";
import { publishTrack } from "../../../lib/server/publish";
import { triggerEnrichment } from "../../../lib/server/spinup";
import {
  type EnrichmentStatusFilter,
  ENRICHMENT_STATUS_FILTERS,
  decodeTrackCursor,
  listTracks,
  searchTracks,
} from "../../../lib/server/tracks";

type AddTrackBody = {
  spotifyUrl?: unknown;
  note?: unknown;
  dryRun?: unknown;
};

// Admin list page size mirrors the public /api/tracks cap (48) — callers page
// through with the cursor rather than asking for a huge single fetch.
const adminDefaultLimit = 16;
const adminMaxLimit = 48;

export const serverHandlers: ApiHandlers = {
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
        status: parseEnrichmentStatus(url.searchParams.get("status")),
      }),
    );
  },
  POST: async ({ request }) => {
    const unauthorized = await requireOperator(request);

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
      // On add, an empty note means "no note" (omit it); PATCH treats "" as a clear.
      const note = parseEditorialNote(body.note);

      const result = await publishTrack(body.spotifyUrl, {
        dryRun: body.dryRun === true,
        note: note || undefined,
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
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/tracks")({
  server: { handlers: aliasHandlers(serverHandlers) },
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

// The enrichment-state filter, validated against the allowed set (the four real
// statuses + "queue", the pending ∪ failed ∪ stale-processing meta-filter the
// enrich-queue/sweep read). Anything else (or absent) → no status filter.
function parseEnrichmentStatus(value: string | null): EnrichmentStatusFilter | undefined {
  return value && (ENRICHMENT_STATUS_FILTERS as readonly string[]).includes(value)
    ? (value as EnrichmentStatusFilter)
    : undefined;
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
