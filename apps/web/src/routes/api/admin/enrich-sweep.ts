import { createFileRoute } from "@tanstack/react-router";
import { type ApiHandlers, aliasHandlers } from "../-alias";
import { requireAdmin } from "../../../lib/server/env";
import { apiErrorResponse } from "../../../lib/server/http-errors";
import { sweepEnrichmentQueue } from "../../../lib/server/spinup";

// POST /api/admin/enrich-sweep — the self-healing enrichment sweep. Queries the
// enrich-queue (pending ∪ failed ∪ stale processing, oldest first) and re-fires
// enrichment for each finding via triggerEnrichment, whose `enrich:${logId}`
// idempotency key de-dupes any in-flight run. An external cron (the same Spinup
// scheduling that runs the newsletter) hits this on an interval; the CLI's
// `fluncle admin enrich-sweep` is a thin client over it.
//
// Admin-gated and Worker-only: the Worker holds the sk_agent_… key, so the
// Spinup trigger stays here, never in the CLI. POST (it has an effect).

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

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

export const serverHandlers: ApiHandlers = {
  POST: async ({ request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    try {
      const url = new URL(request.url);
      const result = await sweepEnrichmentQueue(parseLimit(url.searchParams.get("limit")));

      return Response.json({
        ok: true,
        reEnriched: result.reEnriched,
        reEnrichedCount: result.reEnriched.length,
        skipped: result.skipped,
        skippedCount: result.skipped.length,
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/admin/enrich-sweep")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
