// The `admin-backfills` domain router module — the maintenance sweeps. Each
// handler reuses the live `/api/v1/admin/backfill/*` route logic verbatim; the auth
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
import { backfillVectorCodes } from "../backfill-vector-codes";
import { probeLabelReleases } from "../label-releases";
import { type CoverMasterKind, resolveCoverMasters } from "../cover-masters";
import { resolveLabelImages } from "../label-images";
import { resolveLabelLineage } from "../label-lineage";
import { resolveArtistEdges } from "../backfill-artist-edges";
import { resolveArtistCredits } from "../backfill-artist-credits";
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

  // POST /admin/backfill/label-releases — agent tier (`adminAuth`): the FRESHNESS TAP (D8). A
  // bounded probe over ENABLED seed labels that mints day-one catalogue rows from the official
  // Spotify API's fresh releases (fuzzy `label:` search + the artist-grounding + copyright gate) —
  // catalogue identity only (no publish, no certification, no graph expansion), so the box's
  // agent-token cron drives it. Reuses the publish path's Spotify OAuth, and paces itself against
  // the shared call meter at a FRACTION of the window so a user's playlist mint always finds room.
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
        // Tolerant parse: only `retry=none` re-queues terminal `none` rows; any other value is off.
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

  // POST /admin/backfill/artist-edges — agent tier (`adminAuth`): the track_artists graph backfill
  // (RFC artist-primary-capture, slice 0). Folds each edge-less track's `artists_json` names onto
  // EXISTING artist identities (exact fold + `artist_aliases`) and writes the edges `insert or
  // ignore`. Mints nothing, makes NO vendor call, stamps every visited track so the worklist drains
  // — catalogue-graph identity only (no publish, no certification), so the box's agent-token cron
  // drives it, the `backfill_recording_mbids` precedent.
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
          scanned: result.scanned,
          unmatchedNames: result.unmatchedNames,
          zeroMatched: result.zeroMatched,
          zeroMatchedCount: result.zeroMatchedCount,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/backfill/artist-credits — agent tier (`adminAuth`): the MB credit sweep (RFC
  // artist-primary-capture, slice 1b). Completes slice 0's zero-matched residual — for each
  // zero-matched track with a MusicBrainz recording identity, one paced `inc=artist-credits` lookup
  // through the shared MB client mints/matches artists BY MB id and writes the edges. Catalogue-graph
  // identity only (no publish, no certification), so the box's agent-token cron drives it, the
  // `backfill_recording_mbids` precedent.
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

  // POST /admin/backfill/vector-codes — agent tier (`adminAuth`): the one-time int8 coarse-code
  // drain (RFC vector-search-scale, slice A). A pure in-SQL DB transform (no vendor call, no
  // publish, no certification), so the box's agent-token cron drives it, the `rank_catalogue` class.
  const backfillVectorCodesHandler = os.backfill_vector_codes
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const summary = await backfillVectorCodes(input.limit);

        return { ok: true as const, summary };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    backfill_apple_catalogue: backfillAppleCatalogueHandler,
    backfill_apple_music: backfillAppleMusicHandler,
    backfill_artist_credits: backfillArtistCreditsHandler,
    backfill_artist_edges: backfillArtistEdgesHandler,
    backfill_cover_masters: backfillCoverMastersHandler,
    backfill_discogs: backfillDiscogsHandler,
    backfill_label_images: backfillLabelImagesHandler,
    backfill_label_lineage: backfillLabelLineageHandler,
    backfill_label_releases: backfillLabelReleasesHandler,
    backfill_lastfm: backfillLastfmHandler,
    backfill_recording_mbids: backfillRecordingMbidsHandler,
    backfill_vector_codes: backfillVectorCodesHandler,
  };
}
