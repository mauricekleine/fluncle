// The `admin-backfills` domain router module — the maintenance sweeps. Each
// handler reuses the live `/api/admin/{backfill,enrich-sweep}` route logic
// verbatim; the auth tier moves from the per-handler `requireOperator` /
// `requireAdmin` to the oRPC procedure middleware (../orpc-auth).
//
//   - `backfill_discogs` / `backfill_lastfm` — operator tier (live
//     `requireOperator`): `adminAuth` + `operatorGuard`.
//   - `enrich_track` — admin tier (live `requireAdmin`): `adminAuth` only, so the
//     agent role authenticates too. VERIFIED against the live handler. Routed at
//     `POST /admin/tracks/enrich` (Convention B); the old `/admin/enrich-sweep`
//     path stays a back-compat alias on its TanStack route.
//
// The live routes read `limit`/`dryRun`/`cursor` off the QUERY string of a
// bodyless POST. oRPC's compact input mode sources a POST's input from the body,
// so the contract uses `inputStructure: "detailed"` to expose `query` explicitly;
// the handlers read `input.query.*` and apply the SAME parse/clamp logic the live
// `parseLimit`/`parseBool` did (a tolerant string → number/bool, never a 400).

import { backfillDiscogsIds, backfillLastfmLoves } from "../backfill";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { sweepEnrichmentQueue } from "../spinup";
import { apiFault, type Implementer, parseLimit } from "./_shared";

// Ported verbatim from the live backfill routes.
const BACKFILL_DEFAULT_LIMIT = 50;
const BACKFILL_MAX_LIMIT = 500;

// Ported verbatim from the live enrich-sweep route (a smaller pass budget).
const SWEEP_DEFAULT_LIMIT = 25;
const SWEEP_MAX_LIMIT = 100;

function parseBool(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/**
 * Build the `admin-backfills` domain's handlers. Each reuses the live route logic
 * verbatim; only the auth gate is relocated to the procedure middleware.
 */
export function adminBackfillsHandlers(os: Implementer) {
  // POST /admin/backfill/discogs — operator tier (live `requireOperator`).
  const backfillDiscogsHandler = os.backfill_discogs
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
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
          unresolved: result.unresolved,
          unresolvedCount: result.unresolvedCount,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/backfill/lastfm — operator tier (live `requireOperator`).
  const backfillLastfmHandler = os.backfill_lastfm
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
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
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/tracks/enrich — ADMIN tier (live `requireAdmin`; the agent role
  // authenticates too). `adminAuth` only, NO operatorGuard.
  const enrichTrackHandler = os.enrich_track.use(adminAuth).handler(async ({ input }) => {
    try {
      const result = await sweepEnrichmentQueue(
        parseLimit(input.query.limit, SWEEP_DEFAULT_LIMIT, SWEEP_MAX_LIMIT),
      );

      return {
        ok: true as const,
        reEnriched: result.reEnriched,
        reEnrichedCount: result.reEnriched.length,
        skipped: result.skipped,
        skippedCount: result.skipped.length,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    backfill_discogs: backfillDiscogsHandler,
    backfill_lastfm: backfillLastfmHandler,
    enrich_track: enrichTrackHandler,
  };
}
