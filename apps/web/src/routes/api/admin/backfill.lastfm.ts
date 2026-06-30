import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { backfillLastfmLoves } from "../../../lib/server/backfill";
import { requireOperator } from "../../../lib/server/env";
import { apiErrorResponse } from "../../../lib/server/http-errors";
import { parseBool, parseLimit } from "../../../lib/server/query-params";

// POST /api/admin/backfill/lastfm — back-fill Last.fm `track.love` over published
// findings (a Loved Track = an endorsement, never a scrobble).
// Idempotent (loving twice is a no-op) and
// admin-gated + Worker-only: the Worker holds the LASTFM_* secrets, so the call
// stays here, never in the CLI. The CLI's `fluncle admin backfill lastfm` is a
// thin client over this. POST (it has an effect — when configured).
//
// NOTE: lastfmLove NO-OPS silently without LASTFM_SESSION_KEY, so until that
// secret is confirmed set, even a non-dry run is a safe no-op (it walks the
// findings and reports them "loved", but the Last.fm call short-circuits).
//
// BATCHED: one request handles a bounded pass of eligible findings and returns
// `nextCursor` (the feed cursor to resume from, or null when the archive is
// drained). The CLI loops `?cursor=` until null so a full sweep never exceeds
// the Worker request budget.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export const serverHandlers: ApiHandlers = {
  POST: async ({ request }) => {
    const unauthorized = await requireOperator(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      const url = new URL(request.url);
      const result = await backfillLastfmLoves(
        parseLimit(url.searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT),
        parseBool(url.searchParams.get("dryRun")),
        url.searchParams.get("cursor") ?? undefined,
      );

      return Response.json({
        dryRun: result.dryRun,
        failed: result.failed,
        failedCount: result.failedCount,
        loved: result.loved,
        lovedCount: result.lovedCount,
        nextCursor: result.nextCursor,
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
