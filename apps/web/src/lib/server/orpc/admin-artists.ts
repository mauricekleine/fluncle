// The `admin-artists` domain router module — the artist-entity backfill (Unit 1 of
// the artist-relationship RFC). Follows the `admin-backfills` pattern: a bounded,
// cursor-resumable, agent-tier POST with query params.
//
//   - `backfill_artists` — agent tier (`adminAuth`): the box's `fluncle-artist-backfill`
//     cron drives this. For each eligible finding (no track_artists row yet), the
//     Worker re-fetches the Spotify track metadata and upserts artists + track_artists.
//     Idempotent per finding; rate-paced to stay inside Spotify's burst ceiling.

import {
  addArtistSocial,
  ArtistSocialNotFoundError,
  confirmArtistSocial,
  followArtistSocial,
  followPendingArtists,
  InvalidArtistSocialError,
  listArtistSocialsQueue,
  recordOperatorFollow,
  removeArtistSocial,
  undoArtistSocialFollow,
  unmuteArtistSocial,
} from "../artists";
import { listUnresolvedArtists, resolveArtist } from "../artist-resolution";
import { backfillArtists } from "../backfill-artists";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { ORPCError } from "@orpc/server";
import { apiFault, type Implementer, parseBool, parseLimit } from "./_shared";

const BACKFILL_DEFAULT_LIMIT = 10;
const BACKFILL_MAX_LIMIT = 50;

// The auto-follow sweep's per-tick cap: small so a tick stays inside Spotify's +
// YouTube's quotas. The on-box `fluncle-artist-follow` sweep loops until `remaining` is 0.
const FOLLOW_DEFAULT_LIMIT = 5;
const FOLLOW_MAX_LIMIT = 50;

// The resolve worklist page cap (Unit 2.1's `fluncle-artist-sweep` reads this page).
const QUEUE_DEFAULT_LIMIT = 50;
const QUEUE_MAX_LIMIT = 50;

// Re-express a missing-social / invalid-input server error as the matching oRPC fault
// so the rails encoder reproduces the legacy `{ code, message }` body at the right status.
function toSocialFault(error: unknown): ORPCError<string, { apiCode: string; apiMessage: string }> {
  if (error instanceof ArtistSocialNotFoundError) {
    return new ORPCError("NOT_FOUND", {
      data: { apiCode: "not_found", apiMessage: error.message },
      message: error.message,
      status: 404,
    });
  }

  if (error instanceof InvalidArtistSocialError) {
    return new ORPCError("BAD_REQUEST", {
      data: { apiCode: "invalid_request", apiMessage: error.message },
      message: error.message,
      status: 400,
    });
  }

  return apiFault(error);
}

/**
 * Build the `admin-artists` domain's handlers.
 */
export function adminArtistsHandlers(os: Implementer) {
  // POST /admin/backfill/artists — agent tier (`adminAuth`): internal + reversible
  // metadata enrichment (no publish), so the box's agent-token cron drives it.
  const backfillArtistsHandler = os.backfill_artists.use(adminAuth).handler(async ({ input }) => {
    try {
      const { query } = input;
      const result = await backfillArtists(
        parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
        parseBool(query.dryRun),
        query.cursor ?? undefined,
      );

      return {
        dryRun: result.dryRun,
        failed: result.failed,
        failedCount: result.failedCount,
        nextCursor: result.nextCursor,
        ok: true as const,
        skipped: result.skipped,
        skippedCount: result.skippedCount,
        upserted: result.upserted,
        upsertedCount: result.upsertedCount,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // GET /admin/artists/socials — admin tier (agent-allowed read): the follow queue for
  // the `/admin/artists` station. Returns artists with actionable socials.
  const listArtistSocialsHandler = os.list_artist_socials
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const limit = parseLimit(input.limit, 100, 500);

        return { artists: await listArtistSocialsQueue(limit), ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/artists/follow — agent tier (`adminAuth`, no operatorGuard): the
  // championing motion's automated half. Internal + one-click-reversible (a follow), so
  // the box's agent-token `fluncle-artist-follow` cron drives it, like the backfill.
  const followArtistHandler = os.follow_artist.use(adminAuth).handler(async ({ input }) => {
    try {
      const { query } = input;
      const summary = await followPendingArtists(
        parseLimit(query.limit, FOLLOW_DEFAULT_LIMIT, FOLLOW_MAX_LIMIT),
        parseBool(query.dryRun),
      );

      return { ok: true as const, ...summary };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // POST /admin/artists/socials/{socialId}/follow — operator tier: register a manual follow.
  const recordOperatorFollowHandler = os.record_operator_follow
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return { ok: true as const, social: await recordOperatorFollow(input.socialId) };
      } catch (error) {
        throw toSocialFault(error);
      }
    });

  // POST /admin/artists/socials/{socialId}/follow-now — operator tier: perform the REAL
  // Spotify/YouTube follow on demand (the "Follow now" button), then stamp followed_at.
  const followArtistSocialHandler = os.follow_artist_social
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { platformWarning, social } = await followArtistSocial(input.socialId);

        return { ok: true as const, platformWarning, social };
      } catch (error) {
        throw toSocialFault(error);
      }
    });

  // POST /admin/artists/socials/{socialId}/unfollow — operator tier: undo a follow (real API
  // unfollow for Spotify/YouTube, clear the stamp for the no-API platforms).
  const unfollowArtistSocialHandler = os.unfollow_artist_social
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { platformWarning, social } = await undoArtistSocialFollow(input.socialId);

        return { ok: true as const, platformWarning, social };
      } catch (error) {
        throw toSocialFault(error);
      }
    });

  // POST /admin/artists/socials/{socialId}/unmute — operator tier: clear the don't-champion skip.
  const unmuteArtistSocialHandler = os.unmute_artist_social
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return { ok: true as const, social: await unmuteArtistSocial(input.socialId) };
      } catch (error) {
        throw toSocialFault(error);
      }
    });

  // POST /admin/artists/socials/{socialId}/confirm — operator tier: candidate → confirmed.
  const confirmArtistSocialHandler = os.confirm_artist_social
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return { ok: true as const, social: await confirmArtistSocial(input.socialId) };
      } catch (error) {
        throw toSocialFault(error);
      }
    });

  // POST /admin/artists/{artistId}/socials — operator tier: add/replace a social by platform.
  const addArtistSocialHandler = os.add_artist_social
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const platform = typeof input.platform === "string" ? input.platform : "";
        const url = typeof input.url === "string" ? input.url : "";

        return {
          ok: true as const,
          social: await addArtistSocial(input.artistId, platform, url),
        };
      } catch (error) {
        throw toSocialFault(error);
      }
    });

  // DELETE /admin/artists/socials/{socialId} — operator tier: remove a social.
  const removeArtistSocialHandler = os.remove_artist_social
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        await removeArtistSocial(input.socialId);

        return { ok: true as const };
      } catch (error) {
        throw toSocialFault(error);
      }
    });

  // GET /admin/artists — agent tier (`adminAuth`): the artist-sweep worklist. A bounded,
  // cursor-paged page of artists still awaiting social resolution (`resolved_at IS NULL`),
  // oldest-first. The cron reads this, then resolves each.
  const listUnresolvedArtistsHandler = os.list_unresolved_artists
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const result = await listUnresolvedArtists(
          parseLimit(input.limit, QUEUE_DEFAULT_LIMIT, QUEUE_MAX_LIMIT),
          input.cursor ?? undefined,
        );

        return {
          artists: result.artists,
          nextCursor: result.nextCursor,
          ok: true as const,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/artists/{artistId}/resolve — agent tier (`adminAuth`): MB url-rels
  // walk + Firecrawl gap-fill for one artist. The on-box cron loops the worklist;
  // the CLI calls this ad-hoc. Returns the resolved socials + mbid + wikidata QID.
  const resolveArtistHandler = os.resolve_artist.use(adminAuth).handler(async ({ input }) => {
    try {
      const result = await resolveArtist(input.artistId);

      return {
        artistId: input.artistId,
        mbid: result.mbid,
        ok: true as const,
        rateLimited: result.rateLimited,
        socials: result.socials,
        socialsCount: result.socials.length,
        wikidataQid: result.wikidataQid,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    add_artist_social: addArtistSocialHandler,
    backfill_artists: backfillArtistsHandler,
    confirm_artist_social: confirmArtistSocialHandler,
    follow_artist: followArtistHandler,
    follow_artist_social: followArtistSocialHandler,
    list_artist_socials: listArtistSocialsHandler,
    list_unresolved_artists: listUnresolvedArtistsHandler,
    record_operator_follow: recordOperatorFollowHandler,
    remove_artist_social: removeArtistSocialHandler,
    resolve_artist: resolveArtistHandler,
    unfollow_artist_social: unfollowArtistSocialHandler,
    unmute_artist_social: unmuteArtistSocialHandler,
  };
}
