import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { backfillLastfmLoves } from "../../../lib/server/backfill";
import { requireOperator } from "../../../lib/server/env";
import { apiErrorResponse } from "../../../lib/server/http-errors";

// POST /api/admin/backfill/lastfm — back-fill Last.fm `track.love` over published
// findings (a Loved Track = an endorsement, never a scrobble — see
// docs/rfcs/lastfm-discogs-sync.md §1). Idempotent (loving twice is a no-op) and
// admin-gated + Worker-only: the Worker holds the LASTFM_* secrets, so the call
// stays here, never in the CLI. The CLI's `fluncle admin backfill lastfm` is a
// thin client over this. POST (it has an effect — when configured).
//
// NOTE: lastfmLove NO-OPS silently without LASTFM_SESSION_KEY, so until that
// secret is confirmed set, even a non-dry run is a safe no-op (it walks the
// findings and reports them "loved", but the Last.fm call short-circuits).

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
      const result = await backfillLastfmLoves(
        parseLimit(url.searchParams.get("limit")),
        parseBool(url.searchParams.get("dryRun")),
      );

      return Response.json({
        dryRun: result.dryRun,
        failed: result.failed,
        failedCount: result.failedCount,
        loved: result.loved,
        lovedCount: result.lovedCount,
        ok: true,
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/backfill/lastfm")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
