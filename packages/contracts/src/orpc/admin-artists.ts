import { oc } from "@orpc/contract";
import * as z from "zod";

const ArtistsBackfillFailedSchema = z
  .object({
    error: z.string(),
    logId: z.string(),
  })
  .meta({ id: "ArtistsBackfillFailed" });

export const backfillArtists = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillArtists",
    path: "/admin/backfill/artists",
    summary: "Back-fill artists + track_artists for existing findings (batched)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        cursor: z.string().optional(),
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      dryRun: z.boolean(),
      failed: z.array(ArtistsBackfillFailedSchema),
      failedCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      skipped: z.array(z.string()),
      skippedCount: z.number(),
      upserted: z.array(z.string()),
      upsertedCount: z.number(),
    }),
  );

const ArtistImagesBackfillFailedSchema = z
  .object({
    artistId: z.string(),
    error: z.string(),
  })
  .meta({ id: "ArtistImagesBackfillFailed" });

export const backfillArtistImages = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillArtistImages",
    path: "/admin/backfill/artist-images",
    summary: "Back-fill artist Spotify avatars (image_url) for existing artists (bounded)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        cursor: z.string().optional(),
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      budgetLimited: z.boolean(),
      checkedCount: z.number(),
      dryRun: z.boolean(),
      failed: z.array(ArtistImagesBackfillFailedSchema),
      failedCount: z.number(),
      filled: z.array(z.string()),
      filledCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      queueDepth: z.number(),
      rateLimited: z.boolean(),
      skipped: z.array(z.string()),
      skippedCount: z.number(),
    }),
  );

export const ResolvedSocialSchema = z
  .object({
    platform: z.enum([
      "bandcamp",
      "beatport",
      "bluesky",
      "facebook",
      "homepage",
      "instagram",
      "mixcloud",
      "soundcloud",
      "spotify",
      "tiktok",
      "twitch",
      "twitter",
      "youtube",
    ]),
    source: z.enum(["musicbrainz", "firecrawl"]),
    url: z.string().url(),
  })
  .meta({ id: "ResolvedSocial" });

export const resolveArtist = oc
  .route({
    method: "POST",
    operationId: "resolveArtist",
    path: "/admin/artists/{artistId}/resolve",
    summary: "Resolve an artist's social identity (MB + Firecrawl gap-fill)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      artistId: z.string(),
    }),
  )
  .output(
    z.object({
      artistId: z.string(),
      mbid: z.string().nullable(),
      ok: z.literal(true),
      rateLimited: z.boolean(),
      socials: z.array(ResolvedSocialSchema),
      socialsCount: z.number(),
      wikidataQid: z.string().nullable(),
    }),
  );

export const listUnresolvedArtists = oc
  .route({
    method: "GET",
    operationId: "listUnresolvedArtists",
    path: "/admin/artists",
    summary: "List artists awaiting social resolution, oldest first (the sweep worklist)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      cursor: z.string().optional(),
      limit: z.string().optional(),
    }),
  )
  .output(
    z.object({
      artists: z.array(z.object({ id: z.string(), name: z.string() })),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
    }),
  );

const ArtistSocialSchema = z
  .object({
    artistId: z.string(),
    createdAt: z.string(),
    id: z.string(),
    platform: z.string(),

    reviewedAt: z.string().nullable(),
    source: z.string(),
    status: z.string(),
    url: z.string(),
  })
  .meta({ id: "ArtistSocial" });

const ArtistSocialEnvelope = z.object({ ok: z.literal(true), social: ArtistSocialSchema });

const ArtistSocialsQueueItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    socials: z.array(ArtistSocialSchema),
    spotifyUrl: z.string().nullable(),
  })
  .meta({ id: "ArtistSocialsQueueItem" });

export const listArtistSocials = oc
  .route({
    method: "GET",
    operationId: "listArtistSocials",
    path: "/admin/artists/socials",
    summary: "The artist review queue (artists with unconfirmed socials)",
    tags: ["Admin"],
  })
  .input(z.object({ fresh: z.string().optional(), limit: z.string().optional() }))
  .output(z.object({ artists: z.array(ArtistSocialsQueueItemSchema), ok: z.literal(true) }));

export const confirmArtistSocial = oc
  .route({
    method: "POST",
    operationId: "confirmArtistSocial",
    path: "/admin/artists/socials/{socialId}/confirm",
    summary: "Confirm a candidate artist social (candidate → confirmed)",
    tags: ["Admin"],
  })
  .input(z.object({ socialId: z.string() }))
  .output(ArtistSocialEnvelope);

export const addArtistSocial = oc
  .route({
    method: "POST",
    operationId: "addArtistSocial",
    path: "/admin/artists/{artistId}/socials",
    summary: "Add or replace an artist's social link by platform",
    tags: ["Admin"],
  })
  .input(z.looseObject({ artistId: z.string() }))
  .output(ArtistSocialEnvelope);

export const reviewArtistSocial = oc
  .route({
    method: "POST",
    operationId: "reviewArtistSocial",
    path: "/admin/artists/socials/{socialId}/review",
    summary: "Review one artist social (mark reviewed; candidate → confirmed)",
    tags: ["Admin"],
  })
  .input(z.object({ socialId: z.string() }))
  .output(ArtistSocialEnvelope);

export const reviewArtist = oc
  .route({
    method: "POST",
    operationId: "reviewArtist",
    path: "/admin/artists/{artistId}/review",
    summary: "Mark an artist's link list as reviewed (Looks good)",
    tags: ["Admin"],
  })
  .input(z.object({ artistId: z.string() }))
  .output(z.object({ confirmed: z.number(), ok: z.literal(true) }));

export const removeArtistSocial = oc
  .route({
    method: "DELETE",
    operationId: "removeArtistSocial",
    path: "/admin/artists/socials/{socialId}",
    summary: "Remove an artist social link",
    tags: ["Admin"],
  })
  .input(z.object({ socialId: z.string() }))
  .output(z.object({ ok: z.literal(true) }));

export const updateArtistSocial = oc
  .route({
    method: "PATCH",
    operationId: "updateArtistSocial",
    path: "/admin/artists/socials/{socialId}",
    summary: "Correct + approve an artist social's URL inline (operator)",
    tags: ["Admin"],
  })
  .input(z.looseObject({ socialId: z.string() }))
  .output(ArtistSocialEnvelope);

const DescribeEntityBodySchema = z.looseObject({
  bio: z.unknown().optional(),
  dryRun: z.unknown().optional(),
  finalAttempt: z.boolean().optional(),
  promptVersion: z.number().int().min(0).optional(),
});

export const describeArtist = oc
  .route({
    method: "POST",
    operationId: "describeArtist",
    path: "/admin/artists/{slug}/bio",
    summary: "Auto-author an artist's voiced bio (fills an empty bio only)",
    tags: ["Admin"],
  })
  .input(DescribeEntityBodySchema.extend({ slug: z.string() }))
  .output(
    z.object({
      bio: z.string(),

      dryRun: z.literal(true).optional(),

      gateBypassed: z.literal(true).optional(),
      ok: z.literal(true),

      skipped: z.boolean().optional(),
      slug: z.string(),

      voiceViolations: z.array(z.string()).optional(),
    }),
  );

export const draftArtistBio = oc
  .route({
    method: "GET",
    operationId: "draftArtistBio",
    path: "/admin/artists/{slug}/bio-draft",
    summary: "Assemble a ready-to-author bio prompt for an artist (Worker-side grounding)",
    tags: ["Admin"],
  })
  .input(z.object({ slug: z.string() }))
  .output(
    z.object({
      findingCount: z.number(),
      found: z.boolean(),
      hasFacts: z.boolean(),
      name: z.string(),
      prompt: z.string(),
      promptVersion: z.number(),
    }),
  );

const ArtistBioWorkItemSchema = z
  .object({ id: z.string(), name: z.string(), slug: z.string() })
  .meta({ id: "ArtistBioWorkItem" });

export const listArtistsMissingBio = oc
  .route({
    method: "GET",
    operationId: "listArtistsMissingBio",
    path: "/admin/artists/bio-queue",
    summary: "List artists with findings but no bio yet, oldest first (the bio worklist)",
    tags: ["Admin"],
  })
  .input(z.object({ limit: z.string().optional() }))
  .output(z.object({ artists: z.array(ArtistBioWorkItemSchema), ok: z.literal(true) }));

export const rankArtists = oc
  .route({
    method: "POST",
    operationId: "rankArtists",
    path: "/admin/artists/rank",
    summary: "One tick of the similar-artists sweep (artist centroids + top-K edges)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      countRemaining: z.coerce.boolean().default(false),
      limit: z.coerce.number().int().min(1).max(1000).default(50),
    }),
  )
  .output(
    z.object({
      ok: z.literal(true),
      summary: z.object({
        centroidsComputed: z.number(),
        centroidsRemoved: z.number(),
        edgesWritten: z.number(),
        logicVersion: z.string(),
        remaining: z.number(),
      }),
    }),
  );

export const adminArtistsContract = {
  add_artist_social: addArtistSocial,
  backfill_artist_images: backfillArtistImages,
  backfill_artists: backfillArtists,
  confirm_artist_social: confirmArtistSocial,
  describe_artist: describeArtist,
  draft_artist_bio: draftArtistBio,
  list_artist_socials: listArtistSocials,
  list_artists_missing_bio: listArtistsMissingBio,
  list_unresolved_artists: listUnresolvedArtists,
  rank_artists: rankArtists,
  remove_artist_social: removeArtistSocial,
  resolve_artist: resolveArtist,
  review_artist: reviewArtist,
  review_artist_social: reviewArtistSocial,
  update_artist_social: updateArtistSocial,
};
