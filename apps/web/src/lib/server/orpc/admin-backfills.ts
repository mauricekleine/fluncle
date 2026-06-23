// The `admin-backfills` domain router module — the maintenance sweeps. Each
// handler reuses the live `/api/admin/backfill/*` route logic verbatim; the auth
// tier moves from the per-handler `requireOperator` to the oRPC procedure
// middleware (../orpc-auth).
//
//   - `backfill_discogs` / `backfill_lastfm` — agent tier (`adminAuth`): internal,
//     reversible metadata enrichment (no publish), so the box's agent-token
//     `fluncle-backfill` cron drives them without an operator token.
//
// The live routes read `limit`/`dryRun`/`cursor` off the QUERY string of a
// bodyless POST. oRPC's compact input mode sources a POST's input from the body,
// so the contract uses `inputStructure: "detailed"` to expose `query` explicitly;
// the handlers read `input.query.*` and apply the SAME parse/clamp logic the live
// `parseLimit`/`parseBool` did (a tolerant string → number/bool, never a 400).

import { backfillDiscogsIds, backfillLastfmLoves, backfillObservationAlignment } from "../backfill";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer, parseLimit } from "./_shared";

// Ported verbatim from the live backfill routes.
const BACKFILL_DEFAULT_LIMIT = 50;
const BACKFILL_MAX_LIMIT = 500;

function parseBool(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/**
 * Build the `admin-backfills` domain's handlers. Each reuses the live route logic
 * verbatim; only the auth gate is relocated to the procedure middleware.
 */
export function adminBackfillsHandlers(os: Implementer) {
  // POST /admin/backfill/discogs — agent tier (`adminAuth`): internal + reversible
  // metadata enrichment (no publish), so the box's agent-token `fluncle-backfill`
  // cron drives it without an operator token. See the cron README's token-tier note.
  const backfillDiscogsHandler = os.backfill_discogs.use(adminAuth).handler(async ({ input }) => {
    try {
      const { query } = input;
      const result = await backfillDiscogsIds(
        parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
        parseBool(query.dryRun),
        query.cursor ?? undefined,
      );

      return {
        dryRun: result.dryRun,
        nextCursor: result.nextCursor,
        ok: true as const,
        resolved: result.resolved,
        resolvedCount: result.resolvedCount,
        skipped: result.skipped,
        skippedCount: result.skippedCount,
        unresolved: result.unresolved,
        unresolvedCount: result.unresolvedCount,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // POST /admin/backfill/lastfm — agent tier (`adminAuth`): the Last.fm love is
  // idempotent + reversible (no publish), so the box's agent-token cron drives it.
  const backfillLastfmHandler = os.backfill_lastfm.use(adminAuth).handler(async ({ input }) => {
    try {
      const { query } = input;
      const result = await backfillLastfmLoves(
        parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
        parseBool(query.dryRun),
        query.cursor ?? undefined,
      );

      return {
        dryRun: result.dryRun,
        failed: result.failed,
        failedCount: result.failedCount,
        loved: result.loved,
        lovedCount: result.lovedCount,
        nextCursor: result.nextCursor,
        ok: true as const,
        skipped: result.skipped,
        skippedCount: result.skippedCount,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // POST /admin/backfill/alignment — agent tier (`adminAuth`): re-derive word-level
  // observation caption timings (forced-alignment over the existing mp3, no re-render,
  // no publish), so the box's agent-token cron drives it without an operator token.
  const backfillAlignmentHandler = os.backfill_alignment
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { query } = input;
        const result = await backfillObservationAlignment(
          parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
          parseBool(query.dryRun),
          query.cursor ?? undefined,
        );

        return {
          aligned: result.aligned,
          alignedCount: result.alignedCount,
          dryRun: result.dryRun,
          empty: result.empty,
          emptyCount: result.emptyCount,
          failed: result.failed,
          failedCount: result.failedCount,
          nextCursor: result.nextCursor,
          ok: true as const,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    backfill_alignment: backfillAlignmentHandler,
    backfill_discogs: backfillDiscogsHandler,
    backfill_lastfm: backfillLastfmHandler,
  };
}
