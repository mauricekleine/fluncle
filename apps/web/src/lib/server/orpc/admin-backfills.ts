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

import { env } from "cloudflare:workers";
import {
  backfillAppleMusicCatalogue,
  backfillAppleMusicUrls,
  backfillDiscogsIds,
  backfillLastfmLoves,
} from "../backfill";
import { resolveLabelImages } from "../label-images";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer, parseBool, parseLimit } from "./_shared";

// Ported verbatim from the live backfill routes.
const BACKFILL_DEFAULT_LIMIT = 50;
const BACKFILL_MAX_LIMIT = 500;

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
        rateLimited: result.rateLimited,
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
        rateLimited: result.rateLimited,
        skipped: result.skipped,
        skippedCount: result.skippedCount,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // POST /admin/backfill/apple-music — agent tier (`adminAuth`): resolves each finding's
  // Apple Music URL EXACTLY by ISRC and stores it (no publish), so the box's agent-token
  // cron drives it. A NO-OP until the MusicKit secrets are provisioned (configured:false).
  const backfillAppleMusicHandler = os.backfill_apple_music
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { query } = input;
        const result = await backfillAppleMusicUrls(
          parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
          parseBool(query.dryRun),
          query.cursor ?? undefined,
        );

        return {
          albumFactsWritten: result.albumFactsWritten,
          breakerTripped: result.breakerTripped,
          configured: result.configured,
          dryRun: result.dryRun,
          failed: result.failed,
          failedCount: result.failedCount,
          nextCursor: result.nextCursor,
          ok: true as const,
          rateLimited: result.rateLimited,
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

  // POST /admin/backfill/apple-catalogue — agent tier (`adminAuth`): the catalogue sibling of
  // `backfill_apple_music`. Batched URL drain over uncertified rows + single-ISRC album facts.
  // Catalogue identity only (no publish, no certification), so the box's agent-token cron drives
  // it. A NO-OP until the MusicKit secrets are provisioned (configured:false).
  const backfillAppleCatalogueHandler = os.backfill_apple_catalogue
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { query } = input;
        const result = await backfillAppleMusicCatalogue(
          parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
          parseBool(query.dryRun),
        );

        return {
          albumFactsWritten: result.albumFactsWritten,
          breakerTripped: result.breakerTripped,
          configured: result.configured,
          dryRun: result.dryRun,
          failed: result.failed,
          failedCount: result.failedCount,
          ok: true as const,
          rateLimited: result.rateLimited,
          resolved: result.resolved,
          resolvedCount: result.resolvedCount,
          unresolved: result.unresolved,
          unresolvedCount: result.unresolvedCount,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/backfill/label-images — agent tier (`adminAuth`): resolves a label's OWN logo
  // (Discogs → Wikidata) into R2, no publish, so the box's agent-token cron drives it. The
  // world-served bucket is `env.VIDEOS` (behind found.fluncle.com) — the one the observation /
  // video artifacts already write to.
  const backfillLabelImagesHandler = os.backfill_label_images
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { query } = input;
        const result = await resolveLabelImages(
          env.VIDEOS,
          parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
          parseBool(query.dryRun),
          query.cursor ?? undefined,
        );

        return {
          dryRun: result.dryRun,
          failed: result.failed,
          failedCount: result.failedCount,
          nextCursor: result.nextCursor,
          none: result.none,
          noneCount: result.noneCount,
          ok: true as const,
          rateLimited: result.rateLimited,
          resolved: result.resolved,
          resolvedCount: result.resolvedCount,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    backfill_apple_catalogue: backfillAppleCatalogueHandler,
    backfill_apple_music: backfillAppleMusicHandler,
    backfill_discogs: backfillDiscogsHandler,
    backfill_label_images: backfillLabelImagesHandler,
    backfill_lastfm: backfillLastfmHandler,
  };
}
