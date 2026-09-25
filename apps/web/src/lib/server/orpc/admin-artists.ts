import { rankArtists } from "../artist-dossier";
import {
  addArtistSocial,
  ArtistSocialNotFoundError,
  confirmArtistSocial,
  fillEmptyArtistBio,
  getArtistBySlug,
  InvalidArtistSocialError,
  listArtistsMissingBio,
  listArtistSocialsQueue,
  removeArtistSocial,
  reviewArtist,
  reviewArtistSocial,
  updateArtistSocial,
} from "../artists";
import { listUnresolvedArtists, resolveArtist } from "../artist-resolution";
import { backfillArtistImages } from "../backfill-artist-images";
import { backfillArtists } from "../backfill-artists";
import { buildEntityBioPrompt, fetchEntityFacts, gateOrAcceptBio } from "../bio";
import { purgeEntityCache } from "../edge-cache";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { getFindingsByArtist } from "../tracks";
import { ORPCError } from "@orpc/server";
import { apiFault, type Implementer, parseBool, parseLimit, toFault } from "./_shared";

const BACKFILL_DEFAULT_LIMIT = 10;
const BACKFILL_MAX_LIMIT = 50;

const QUEUE_DEFAULT_LIMIT = 50;
const QUEUE_MAX_LIMIT = 50;

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

export function adminArtistsHandlers(os: Implementer) {
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

  const backfillArtistImagesHandler = os.backfill_artist_images
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { query } = input;
        const result = await backfillArtistImages(
          parseLimit(query.limit, BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT),
          parseBool(query.dryRun),
          query.cursor ?? undefined,
        );

        return {
          budgetLimited: result.budgetLimited,
          checkedCount: result.checkedCount,
          dryRun: result.dryRun,
          failed: result.failed,
          failedCount: result.failedCount,
          filled: result.filled,
          filledCount: result.filledCount,
          nextCursor: result.nextCursor,
          ok: true as const,
          queueDepth: result.queueDepth,
          rateLimited: result.rateLimited,
          skipped: result.skipped,
          skippedCount: result.skippedCount,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const listArtistSocialsHandler = os.list_artist_socials
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const limit = parseLimit(input.limit, 100, 500);

        return {
          artists: await listArtistSocialsQueue(limit, parseBool(input.fresh)),
          ok: true as const,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

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

  const reviewArtistHandler = os.review_artist
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { confirmed } = await reviewArtist(input.artistId);

        return { confirmed, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const reviewArtistSocialHandler = os.review_artist_social
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return { ok: true as const, social: await reviewArtistSocial(input.socialId) };
      } catch (error) {
        throw toSocialFault(error);
      }
    });

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

  const updateArtistSocialHandler = os.update_artist_social
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const url = typeof input.url === "string" ? input.url : "";

        return { ok: true as const, social: await updateArtistSocial(input.socialId, url) };
      } catch (error) {
        throw toSocialFault(error);
      }
    });

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

  const describeArtistHandler = os.describe_artist.use(adminAuth).handler(async ({ input }) => {
    try {
      const dryRun = input.dryRun === true;
      const artist = await getArtistBySlug(input.slug);

      if (!artist) {
        throw new ORPCError("NOT_FOUND", {
          data: { apiCode: "not_found", apiMessage: `No artist with slug ${input.slug}` },
          message: `No artist with slug ${input.slug}`,
          status: 404,
        });
      }

      if (!dryRun && artist.bio?.trim()) {
        return { bio: artist.bio, ok: true as const, skipped: true as const, slug: artist.slug };
      }

      const gated = gateOrAcceptBio({
        bio: input.bio,
        finalAttempt: input.finalAttempt === true,
        kind: "artist",
        name: artist.name,
        slug: artist.slug,
      });

      const { bio } = gated;

      if (dryRun) {
        return { ...gated, dryRun: true as const, ok: true as const, slug: artist.slug };
      }

      const filled = await fillEmptyArtistBio(
        artist.slug,
        bio,
        input.promptVersion,
        gated.voiceViolations ?? null,
      );

      if (!filled) {
        const current = await getArtistBySlug(input.slug);

        return {
          bio: current?.bio ?? bio,
          ok: true as const,
          skipped: true as const,
          slug: artist.slug,
        };
      }

      purgeEntityCache("artist", artist.slug);

      return { ...gated, ok: true as const, slug: artist.slug };
    } catch (error) {
      throw toFault(error);
    }
  });

  const draftArtistBioHandler = os.draft_artist_bio.use(adminAuth).handler(async ({ input }) => {
    try {
      const artist = await getArtistBySlug(input.slug);

      if (!artist) {
        return {
          findingCount: 0,
          found: false as const,
          hasFacts: false,
          name: "",
          prompt: "",
          promptVersion: 0,
        };
      }

      const facts = await fetchEntityFacts({ kind: "artist", name: artist.name });
      const findings = await getFindingsByArtist(artist.id, artist.name);
      const findingTitles = findings.map((finding) => finding.title);

      const { body, version } = await buildEntityBioPrompt({
        facts: facts?.facts ?? null,
        findingTitles,
        kind: "artist",
        name: artist.name,
      });

      return {
        findingCount: findingTitles.length,
        found: true as const,
        hasFacts: facts != null,
        name: artist.name,
        prompt: body,
        promptVersion: version,
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  const listArtistsMissingBioHandler = os.list_artists_missing_bio
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const artists = await listArtistsMissingBio(parseLimit(input.limit, 50, 200));

        return { artists, ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const rankArtistsHandler = os.rank_artists.use(adminAuth).handler(async ({ input }) => {
    try {
      return {
        ok: true as const,
        summary: await rankArtists(input.limit, undefined, input.countRemaining),
      };
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    add_artist_social: addArtistSocialHandler,
    backfill_artist_images: backfillArtistImagesHandler,
    backfill_artists: backfillArtistsHandler,
    confirm_artist_social: confirmArtistSocialHandler,
    describe_artist: describeArtistHandler,
    draft_artist_bio: draftArtistBioHandler,
    list_artist_socials: listArtistSocialsHandler,
    list_artists_missing_bio: listArtistsMissingBioHandler,
    list_unresolved_artists: listUnresolvedArtistsHandler,
    rank_artists: rankArtistsHandler,
    remove_artist_social: removeArtistSocialHandler,
    resolve_artist: resolveArtistHandler,
    review_artist: reviewArtistHandler,
    review_artist_social: reviewArtistSocialHandler,
    update_artist_social: updateArtistSocialHandler,
  };
}
