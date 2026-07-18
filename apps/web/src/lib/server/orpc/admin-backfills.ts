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
import { type CoverMasterKind, resolveCoverMasters } from "../cover-masters";
import { resolveLabelImages } from "../label-images";
import { resolveLabelLineage } from "../label-lineage";
import { adminAuth } from "../orpc-auth";
import { resolveRecordingMbids } from "../recording-mbids";
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

  // POST /admin/backfill/label-lineage — agent tier (`adminAuth`): resolves a label's FOUNDING facts
  // (date, place) + its parent imprint from MusicBrainz, no publish, so the box's agent-token cron
  // drives it. Reads only — writes catalogue metadata onto the `labels` row, never mints a label.
  const backfillLabelLineageHandler = os.backfill_label_lineage
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { query } = input;
        const result = await resolveLabelLineage(
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
          unmatchedParents: result.unmatchedParents,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/backfill/cover-masters — agent tier (`adminAuth`): resolves an album's/artist's OWN
  // ≤1200²-capped cover master (RFC U3b) into R2, no publish, so the box's agent-token cron drives
  // it. The world-served bucket is `env.VIDEOS` (found.fluncle.com), the label-logo precedent.
  const backfillCoverMastersHandler = os.backfill_cover_masters
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { query } = input;
        // Tolerant parse, like limit/dryRun: any value other than `artist` is `album` (the default).
        const kind: CoverMasterKind = query.kind === "artist" ? "artist" : "album";
        const result = await resolveCoverMasters(
          env.VIDEOS,
          kind,
          parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
          parseBool(query.dryRun),
          query.cursor ?? undefined,
        );

        return {
          dryRun: result.dryRun,
          failed: result.failed,
          failedCount: result.failedCount,
          kind: result.kind,
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

  // POST /admin/backfill/recording-mbids — agent tier (`adminAuth`): the MusicBrainz identity
  // layer. It fills each track's canonical recording MBID (crawler PK strip + ISRC resolve through
  // the shared MusicBrainz client), writing catalogue identity only (no publish, no certification),
  // so the box's agent-token cron drives it, the `backfill_label_images` precedent.
  const backfillRecordingMbidsHandler = os.backfill_recording_mbids
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { query } = input;
        const result = await resolveRecordingMbids(
          parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
          parseBool(query.dryRun),
          query.cursor ?? undefined,
        );

        return {
          dryRun: result.dryRun,
          failed: result.failed,
          failedCount: result.failedCount,
          missed: result.missed,
          missedCount: result.missedCount,
          nextCursor: result.nextCursor,
          ok: true as const,
          prefixStripped: result.prefixStripped,
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
    backfill_cover_masters: backfillCoverMastersHandler,
    backfill_discogs: backfillDiscogsHandler,
    backfill_label_images: backfillLabelImagesHandler,
    backfill_label_lineage: backfillLabelLineageHandler,
    backfill_lastfm: backfillLastfmHandler,
    backfill_recording_mbids: backfillRecordingMbidsHandler,
  };
}
