import { env } from "cloudflare:workers";
import {
  backfillAppleMusicCatalogue,
  backfillAppleMusicUrls,
  backfillBeatportUrls,
  backfillDeezer,
  backfillDiscogsFacts,
  backfillDiscogsIds,
  backfillLastfmLoves,
} from "../backfill";
import { probeLabelReleases } from "../label-releases";
import { type CoverMasterKind, resolveCoverMasters } from "../cover-masters";
import { resolveLabelImages } from "../label-images";
import { resolveLabelLineage } from "../label-lineage";
import { resolveArtistEdges } from "../backfill-artist-edges";
import { resolveArtistCredits } from "../backfill-artist-credits";
import { adminAuth } from "../orpc-auth";
import { resolveRecordingMbids } from "../recording-mbids";
import { apiFault, type Implementer, parseBool, parseLimit } from "./_shared";

const BACKFILL_DEFAULT_LIMIT = 50;
const BACKFILL_MAX_LIMIT = 500;

const ISRC_REFRESH_DEFAULT_LIMIT = 25;

export function parseIsrcRefreshLimit(value: string | undefined): number {
  if (value === undefined || value === "") {
    return ISRC_REFRESH_DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    return ISRC_REFRESH_DEFAULT_LIMIT;
  }

  return Math.min(parsed, ISRC_REFRESH_DEFAULT_LIMIT);
}

export function adminBackfillsHandlers(os: Implementer) {
  const backfillDiscogsHandler = os.backfill_discogs.use(adminAuth).handler(async ({ input }) => {
    try {
      const { query } = input;
      const result = await backfillDiscogsIds(
        parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
        parseBool(query.dryRun),
        query.cursor ?? undefined,
        {
          boxFetch: parseBool(query.boxFetch),
          discogsCandidates: input.body?.discogsCandidates,
        },
      );

      return {
        discogsWork: result.discogsWork ?? [],
        dryRun: result.dryRun,
        nextCursor: result.nextCursor,
        ok: true as const,
        rateLimited: result.rateLimited,
        rateLimitedBy: result.rateLimitedBy,
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

  const backfillDiscogsFactsHandler = os.backfill_discogs_facts
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { query } = input;
        const result = await backfillDiscogsFacts(
          parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
          parseBool(query.dryRun),
          {
            boxFetch: parseBool(query.boxFetch),
            discogsCandidates: input.body?.discogsCandidates,
          },
        );

        return {
          configured: result.configured,
          discogsWork: result.discogsWork ?? [],
          dryRun: result.dryRun,
          failed: result.failed,
          failedCount: result.failedCount,
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

  const backfillBeatportHandler = os.backfill_beatport.use(adminAuth).handler(async ({ input }) => {
    try {
      const { query } = input;
      const result = await backfillBeatportUrls(
        parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
        parseBool(query.dryRun),
        query.cursor ?? undefined,
      );

      return {
        catalogueFailed: result.catalogueFailed,
        catalogueFailedCount: result.catalogueFailedCount,
        catalogueResolved: result.catalogueResolved,
        catalogueResolvedCount: result.catalogueResolvedCount,
        catalogueUnresolved: result.catalogueUnresolved,
        catalogueUnresolvedCount: result.catalogueUnresolvedCount,
        configured: result.configured,
        dryRun: result.dryRun,
        failed: result.failed,
        failedCount: result.failedCount,
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

  const backfillDeezerHandler = os.backfill_deezer.use(adminAuth).handler(async ({ input }) => {
    try {
      const { query } = input;
      const result = await backfillDeezer(
        parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
        parseBool(query.dryRun),
      );

      return {
        dryRun: result.dryRun,
        failed: result.failed,
        failedCount: result.failedCount,
        ok: true as const,
        rateLimited: result.rateLimited,
        resolved: result.resolved,
        resolvedCount: result.resolvedCount,
        unresolved: result.unresolved,
        unresolvedCount: result.unresolvedCount,
        unvouchable: result.unvouchable,
        unvouchableCount: result.unvouchableCount,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

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

  const backfillLabelReleasesHandler = os.backfill_label_releases
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const result = await probeLabelReleases({ dryRun: input.dryRun, limit: input.limit });

        return {
          albumsMatched: result.albumsMatched,
          albumsSeen: result.albumsSeen,
          budgetPaused: result.budgetPaused,
          configured: result.configured,
          dryRun: result.dryRun,
          failedFetches: result.failedFetches,
          failedLabels: result.failedLabels,
          fetchCeilingHit: result.fetchCeilingHit,
          labelSlugs: result.labelSlugs,
          labelsProbed: result.labelsProbed,
          newRows: result.newRows,
          newTrackIds: result.newTrackIds,
          ok: true as const,
          rateLimited: result.rateLimited,
          skippedKnown: result.skippedKnown,
          skippedUndated: result.skippedUndated,
          skippedUngrounded: result.skippedUngrounded,
          tracksSkippedArtistRule: result.tracksSkippedArtistRule,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

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
          {
            boxFetch: parseBool(query.boxFetch),
            discogsCandidates: input.body?.discogsCandidates,
          },
        );

        return {
          discogsWork: result.discogsWork ?? [],
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

  const backfillCoverMastersHandler = os.backfill_cover_masters
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { query } = input;

        const kind: CoverMasterKind = query.kind === "artist" ? "artist" : "album";

        const retryNone = query.retry === "none";
        const result = await resolveCoverMasters(
          env.VIDEOS,
          kind,
          parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
          parseBool(query.dryRun),
          query.cursor ?? undefined,
          retryNone,
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
          requeued: result.requeued,
          requeuedCount: result.requeuedCount,
          resolved: result.resolved,
          resolvedCount: result.resolvedCount,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const backfillRecordingMbidsHandler = os.backfill_recording_mbids
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { query } = input;
        const result = await resolveRecordingMbids(
          parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
          parseBool(query.dryRun),
          query.cursor ?? undefined,
          parseIsrcRefreshLimit(query.isrcRefreshLimit),
        );

        return {
          dryRun: result.dryRun,
          failed: result.failed,
          failedCount: result.failedCount,
          isrcRefreshMissed: result.isrcRefreshMissed,
          isrcRefreshMissedCount: result.isrcRefreshMissedCount,
          isrcRefreshed: result.isrcRefreshed,
          isrcRefreshedCount: result.isrcRefreshedCount,
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

  const backfillArtistEdgesHandler = os.backfill_artist_edges
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { query } = input;
        const result = await resolveArtistEdges(
          parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
          parseBool(query.dryRun),
          query.cursor ?? undefined,
        );

        return {
          dryRun: result.dryRun,
          edgesWritten: result.edgesWritten,
          fullyMatched: result.fullyMatched,
          fullyMatchedCount: result.fullyMatchedCount,
          nextCursor: result.nextCursor,
          ok: true as const,
          partiallyMatched: result.partiallyMatched,
          partiallyMatchedCount: result.partiallyMatchedCount,
          queueDepth: result.queueDepth,
          scanned: result.scanned,
          unmatchedNames: result.unmatchedNames,
          zeroMatched: result.zeroMatched,
          zeroMatchedCount: result.zeroMatchedCount,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const backfillArtistCreditsHandler = os.backfill_artist_credits
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { query } = input;
        const result = await resolveArtistCredits(
          parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
          parseBool(query.dryRun),
          query.cursor ?? undefined,
        );

        return {
          adoptedArtists: result.adoptedArtists,
          dryRun: result.dryRun,
          edgesWritten: result.edgesWritten,
          matchedArtists: result.matchedArtists,
          mintedArtists: result.mintedArtists,
          nextCursor: result.nextCursor,
          ok: true as const,
          rateLimited: result.rateLimited,
          scanned: result.scanned,
          skippedNoIdentity: result.skippedNoIdentity,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    backfill_apple_catalogue: backfillAppleCatalogueHandler,
    backfill_apple_music: backfillAppleMusicHandler,
    backfill_artist_credits: backfillArtistCreditsHandler,
    backfill_artist_edges: backfillArtistEdgesHandler,
    backfill_beatport: backfillBeatportHandler,
    backfill_cover_masters: backfillCoverMastersHandler,
    backfill_deezer: backfillDeezerHandler,
    backfill_discogs: backfillDiscogsHandler,
    backfill_discogs_facts: backfillDiscogsFactsHandler,
    backfill_label_images: backfillLabelImagesHandler,
    backfill_label_lineage: backfillLabelLineageHandler,
    backfill_label_releases: backfillLabelReleasesHandler,
    backfill_lastfm: backfillLastfmHandler,
    backfill_recording_mbids: backfillRecordingMbidsHandler,
  };
}
