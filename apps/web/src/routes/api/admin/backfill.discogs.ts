import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { backfillDiscogsIds } from "../../../lib/server/backfill";
import { requireOperator } from "../../../lib/server/env";
import { apiErrorResponse } from "../../../lib/server/http-errors";

// POST /api/admin/backfill/discogs — back-fill Discogs `in_release_id` /
// `in_master_id` over published findings that never got one (added before the
// resolver shipped, or below the 0.9 gate at the time). discogsResolveRelease
// stores NOTHING below the gate, so an unresolved finding correctly stays null;
// on a confident match the ids are written SERVER-SIDE (the same columns
// publishTrack sets), never through the generic PATCH endpoint, which doesn't
// expose them. Admin-gated + Worker-only (the Worker holds DISCOGS_USER_TOKEN);
// rows that already have a release id are skipped (idempotent).
//
// BATCHED: each resolve runs under a ~1.1s rate limiter, so one request handles
// only a bounded pass of eligible findings and returns `nextCursor` (the feed
// cursor to resume from, or null when the archive is drained). The CLI's
// `fluncle admin backfill discogs` loops `?cursor=` until null — this is what
// keeps a full sweep from exceeding the Worker request budget.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function parseLimit(value: string | null): number {
  if (!value) {
    return DEFAULT_LIMIT;
  }

  const limit = Number.parseInt(value, 10);

  if (!Number.isInteger(limit) || limit < 1) {
    return DEFAULT_LIMIT;
  }

  return Math.min(limit, MAX_LIMIT);
}

function parseBool(value: string | null): boolean {
  return value === "1" || value === "true";
}

export const serverHandlers: ApiHandlers = {
  POST: async ({ request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      const url = new URL(request.url);
      const result = await backfillDiscogsIds(
        parseLimit(url.searchParams.get("limit")),
        parseBool(url.searchParams.get("dryRun")),
        url.searchParams.get("cursor") ?? undefined,
      );

      return Response.json({
        dryRun: result.dryRun,
        nextCursor: result.nextCursor,
        ok: true,
        resolved: result.resolved,
        resolvedCount: result.resolvedCount,
        unresolved: result.unresolved,
        unresolvedCount: result.unresolvedCount,
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/backfill/discogs")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
