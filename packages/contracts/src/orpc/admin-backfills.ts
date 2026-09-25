import { oc } from "@orpc/contract";
import * as z from "zod";

export const DISCOGS_RELEASE_WORK_LIMIT = 3;
export const DISCOGS_SEARCH_QUERY_LIMIT = 3;
export const DISCOGS_RELEASES_PER_TRACK_LIMIT = 12;
export const DISCOGS_FACTS_WORK_LIMIT = 25;
export const DISCOGS_LABEL_WORK_LIMIT = 4;

const DISCOGS_ID_MAX = Number.MAX_SAFE_INTEGER;
const DISCOGS_TEXT_MAX = 500;
const DISCOGS_URI_MAX = 2_048;
const DISCOGS_QUERY_MAX = 2_048;
const DISCOGS_ARTIST_LIMIT = 20;
const DISCOGS_LABEL_LIMIT = 20;
const DISCOGS_STYLE_LIMIT = 50;
const DISCOGS_FORMAT_LIMIT = 20;
const DISCOGS_TRACKLIST_LIMIT = 500;
const DISCOGS_LABEL_DETAIL_IMAGE_LIMIT = 20;
const MAX_LABEL_IMAGE_BYTES = 5_000_000;

const MAX_LABEL_IMAGE_BASE64_CHARS = Math.ceil((MAX_LABEL_IMAGE_BYTES * 4) / 3) + 2;

const DiscogsIdSchema = z.number().int().positive().max(DISCOGS_ID_MAX);
const DiscogsTextSchema = z.string().max(DISCOGS_TEXT_MAX);

export const DiscogsReleaseEvidenceSchema = z
  .object({
    artists: z.array(z.object({ name: DiscogsTextSchema.optional() })).max(DISCOGS_ARTIST_LIMIT),
    formats: z.array(z.object({ name: DiscogsTextSchema.optional() })).max(DISCOGS_FORMAT_LIMIT),
    id: DiscogsIdSchema,
    labels: z
      .array(
        z.object({
          catno: DiscogsTextSchema.optional(),
          name: DiscogsTextSchema.optional(),
        }),
      )
      .max(DISCOGS_LABEL_LIMIT),
    masterId: DiscogsIdSchema.optional(),

    searchMasterId: DiscogsIdSchema.optional(),
    styles: z.array(DiscogsTextSchema).max(DISCOGS_STYLE_LIMIT),
    title: DiscogsTextSchema.optional(),
    tracklist: z
      .array(z.object({ title: DiscogsTextSchema.optional() }))
      .max(DISCOGS_TRACKLIST_LIMIT),
    year: z.number().int().min(1_000).max(9_999).optional(),
  })
  .meta({ id: "DiscogsReleaseEvidence" });

export const DiscogsReleaseCandidateSchema = z
  .object({
    releases: z.array(DiscogsReleaseEvidenceSchema).max(DISCOGS_RELEASES_PER_TRACK_LIMIT),
    trackId: z.string().min(1).max(DISCOGS_TEXT_MAX),
  })
  .meta({ id: "DiscogsReleaseCandidate" });

const DiscogsReleaseCandidateBatchSchema = z
  .array(DiscogsReleaseCandidateSchema)
  .max(DISCOGS_RELEASE_WORK_LIMIT)
  .superRefine((entries, context) => {
    const trackIds = new Set<string>();

    for (const entry of entries) {
      if (trackIds.has(entry.trackId)) {
        context.addIssue({
          code: "custom",
          message: "Discogs candidate track ids must be unique",
        });
        return;
      }

      trackIds.add(entry.trackId);
    }
  });

export const DiscogsReleaseWorkSchema = z
  .object({
    queries: z.array(z.string().min(1).max(DISCOGS_QUERY_MAX)).max(DISCOGS_SEARCH_QUERY_LIMIT),
    trackId: z.string().min(1).max(DISCOGS_TEXT_MAX),
  })
  .meta({ id: "DiscogsReleaseWork" });

export const DiscogsFactsWorkSchema = z
  .object({
    releaseId: DiscogsIdSchema,
    slug: z.string().min(1).max(DISCOGS_TEXT_MAX),
  })
  .meta({ id: "DiscogsFactsWork" });

export const DiscogsFactsCandidateSchema = z
  .object({
    release: DiscogsReleaseEvidenceSchema,
    slug: z.string().min(1).max(DISCOGS_TEXT_MAX),
  })
  .meta({ id: "DiscogsFactsCandidate" });

const DiscogsFactsCandidateBatchSchema = z
  .array(DiscogsFactsCandidateSchema)
  .max(DISCOGS_FACTS_WORK_LIMIT)
  .superRefine((entries, context) => {
    const slugs = new Set<string>();

    for (const entry of entries) {
      if (slugs.has(entry.slug)) {
        context.addIssue({
          code: "custom",
          message: "Discogs facts candidate slugs must be unique",
        });
        return;
      }

      slugs.add(entry.slug);
    }
  });

const DiscogsLabelDetailImageSchema = z.object({
  type: z.enum(["primary", "secondary"]).optional(),
  uri: z.string().min(1).max(DISCOGS_URI_MAX).optional(),
});

const DiscogsLabelImageBytesSchema = z.object({
  bytesBase64: z
    .string()
    .min(1)
    .max(MAX_LABEL_IMAGE_BASE64_CHARS)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  mime: z
    .string()
    .min(1)
    .max(100)
    .regex(/^image\/[A-Za-z0-9.+-]+$/),
  uri: z.string().min(1).max(DISCOGS_URI_MAX),
});

export const DiscogsLabelCandidateSchema = z
  .object({
    detail: z.object({
      id: DiscogsIdSchema,
      images: z.array(DiscogsLabelDetailImageSchema).max(DISCOGS_LABEL_DETAIL_IMAGE_LIMIT),
    }),
    discogsLabelId: DiscogsIdSchema,
    image: DiscogsLabelImageBytesSchema.optional(),
    slug: z.string().min(1).max(DISCOGS_TEXT_MAX),
  })
  .superRefine((candidate, context) => {
    if (candidate.detail.id !== candidate.discogsLabelId) {
      context.addIssue({
        code: "custom",
        message: "Discogs label detail id must match its work id",
      });
    }
  })
  .meta({ id: "DiscogsLabelCandidate" });

const DiscogsLabelCandidateBatchSchema = z
  .array(DiscogsLabelCandidateSchema)
  .max(DISCOGS_LABEL_WORK_LIMIT)
  .superRefine((entries, context) => {
    const slugs = new Set<string>();
    const base64Chars = entries.reduce(
      (total, entry) => total + (entry.image?.bytesBase64.length ?? 0),
      0,
    );

    if (base64Chars > MAX_LABEL_IMAGE_BASE64_CHARS * DISCOGS_LABEL_WORK_LIMIT) {
      context.addIssue({
        code: "custom",
        message: "Discogs label-image candidate batch exceeds its decoded-image budget",
      });
    }

    for (const entry of entries) {
      if (slugs.has(entry.slug)) {
        context.addIssue({
          code: "custom",
          message: "Discogs label candidate slugs must be unique",
        });
        return;
      }

      slugs.add(entry.slug);
    }
  });

export const DiscogsLabelWorkSchema = z
  .object({
    discogsLabelId: DiscogsIdSchema,
    slug: z.string().min(1).max(DISCOGS_TEXT_MAX),
  })
  .meta({ id: "DiscogsLabelWork" });

export type DiscogsReleaseEvidence = z.infer<typeof DiscogsReleaseEvidenceSchema>;
export type DiscogsReleaseCandidate = z.infer<typeof DiscogsReleaseCandidateSchema>;
export type DiscogsReleaseWork = z.infer<typeof DiscogsReleaseWorkSchema>;
export type DiscogsFactsCandidate = z.infer<typeof DiscogsFactsCandidateSchema>;
export type DiscogsFactsWork = z.infer<typeof DiscogsFactsWorkSchema>;
export type DiscogsLabelCandidate = z.infer<typeof DiscogsLabelCandidateSchema>;
export type DiscogsLabelWork = z.infer<typeof DiscogsLabelWorkSchema>;

const DiscogsResolvedSchema = z
  .object({
    logId: z.string(),
    masterId: z.number().optional(),
    releaseId: z.number(),
    source: z.string(),
  })
  .meta({ id: "DiscogsBackfillResolved" });

const LastfmFailedSchema = z
  .object({
    error: z.string(),
    logId: z.string(),
  })
  .meta({ id: "LastfmBackfillFailed" });

const AppleMusicResolvedSchema = z
  .object({
    logId: z.string(),
    url: z.string(),
  })
  .meta({ id: "AppleMusicBackfillResolved" });

const AppleMusicFailedSchema = z
  .object({
    error: z.string(),
    logId: z.string(),
  })
  .meta({ id: "AppleMusicBackfillFailed" });

export const backfillDiscogs = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillDiscogs",
    path: "/admin/backfill/discogs",
    summary: "Back-fill Discogs release ids over published findings (batched)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      body: z
        .object({
          discogsCandidates: DiscogsReleaseCandidateBatchSchema.optional(),
        })
        .optional(),
      query: z.object({
        boxFetch: z.string().optional(),
        cursor: z.string().optional(),
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      discogsWork: z.array(DiscogsReleaseWorkSchema).max(DISCOGS_RELEASE_WORK_LIMIT),
      dryRun: z.boolean(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),

      rateLimited: z.boolean(),

      rateLimitedBy: z.enum(["discogs", "musicbrainz"]).nullable(),
      resolved: z.array(DiscogsResolvedSchema),
      resolvedCount: z.number(),

      skipped: z.array(z.string()),
      skippedCount: z.number(),
      unresolved: z.array(z.string()),
      unresolvedCount: z.number(),
    }),
  );

const DiscogsFactsResolvedSchema = z
  .object({
    catno: z.string(),
    slug: z.string(),
  })
  .meta({ id: "DiscogsFactsResolved" });

const DiscogsFactsFailedSchema = z
  .object({
    error: z.string(),
    slug: z.string(),
  })
  .meta({ id: "DiscogsFactsFailed" });

export const backfillDiscogsFacts = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillDiscogsFacts",
    path: "/admin/backfill/discogs-facts",
    summary: "Back-fill album catalogue numbers + styles from already-resolved Discogs releases",
    tags: ["Admin"],
  })
  .input(
    z.object({
      body: z
        .object({
          discogsCandidates: DiscogsFactsCandidateBatchSchema.optional(),
        })
        .optional(),
      query: z.object({
        boxFetch: z.string().optional(),
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      configured: z.boolean(),
      discogsWork: z.array(DiscogsFactsWorkSchema).max(DISCOGS_FACTS_WORK_LIMIT),
      dryRun: z.boolean(),
      failed: z.array(DiscogsFactsFailedSchema),
      failedCount: z.number(),

      none: z.array(z.string()),
      noneCount: z.number(),
      ok: z.literal(true),

      rateLimited: z.boolean(),
      resolved: z.array(DiscogsFactsResolvedSchema),
      resolvedCount: z.number(),
    }),
  );

export const backfillLastfm = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillLastfm",
    path: "/admin/backfill/lastfm",
    summary: "Back-fill Last.fm loves over published findings (batched)",
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
      failed: z.array(LastfmFailedSchema),
      failedCount: z.number(),
      loved: z.array(z.string()),
      lovedCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),

      rateLimited: z.boolean(),

      skipped: z.array(z.string()),
      skippedCount: z.number(),
    }),
  );

export const backfillAppleMusic = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillAppleMusic",
    path: "/admin/backfill/apple-music",
    summary: "Back-fill Apple Music URLs over published findings by exact ISRC (batched)",
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
      albumFactsWritten: z.number(),

      breakerTripped: z.boolean(),

      configured: z.boolean(),
      dryRun: z.boolean(),
      failed: z.array(AppleMusicFailedSchema),
      failedCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),

      rateLimited: z.boolean(),
      resolved: z.array(AppleMusicResolvedSchema),
      resolvedCount: z.number(),

      skipped: z.array(z.string()),
      skippedCount: z.number(),

      unresolved: z.array(z.string()),
      unresolvedCount: z.number(),
    }),
  );

const AppleCatalogueResolvedSchema = z
  .object({
    trackId: z.string(),
    url: z.string(),
  })
  .meta({ id: "AppleCatalogueResolved" });

const AppleCatalogueFailedSchema = z
  .object({
    error: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "AppleCatalogueFailed" });

export const backfillAppleCatalogue = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillAppleCatalogue",
    path: "/admin/backfill/apple-catalogue",
    summary: "Back-fill Apple URLs + album facts over catalogue tracks by exact ISRC (batched)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      albumFactsWritten: z.number(),

      breakerTripped: z.boolean(),
      configured: z.boolean(),
      dryRun: z.boolean(),
      failed: z.array(AppleCatalogueFailedSchema),
      failedCount: z.number(),
      ok: z.literal(true),
      rateLimited: z.boolean(),
      resolved: z.array(AppleCatalogueResolvedSchema),
      resolvedCount: z.number(),

      unresolved: z.array(z.string()),
      unresolvedCount: z.number(),
    }),
  );

const BeatportResolvedSchema = z
  .object({
    logId: z.string(),
    url: z.string(),
  })
  .meta({ id: "BeatportResolved" });

const BeatportFailedSchema = z
  .object({
    error: z.string(),
    logId: z.string(),
  })
  .meta({ id: "BeatportFailed" });

const BeatportCatalogueResolvedSchema = z
  .object({
    trackId: z.string(),
    url: z.string(),
  })
  .meta({ id: "BeatportCatalogueResolved" });

const BeatportCatalogueFailedSchema = z
  .object({
    error: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "BeatportCatalogueFailed" });

export const backfillBeatport = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillBeatport",
    path: "/admin/backfill/beatport",
    summary: "Back-fill Beatport URLs over published findings by exact ISRC",
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
      catalogueFailed: z.array(BeatportCatalogueFailedSchema),
      catalogueFailedCount: z.number(),
      catalogueResolved: z.array(BeatportCatalogueResolvedSchema),
      catalogueResolvedCount: z.number(),
      catalogueUnresolved: z.array(z.string()),
      catalogueUnresolvedCount: z.number(),
      configured: z.boolean(),
      dryRun: z.boolean(),
      failed: z.array(BeatportFailedSchema),
      failedCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),
      resolved: z.array(BeatportResolvedSchema),
      resolvedCount: z.number(),
      skipped: z.array(z.string()),
      skippedCount: z.number(),

      unresolved: z.array(z.string()),
      unresolvedCount: z.number(),
    }),
  );

const DeezerResolvedSchema = z
  .object({
    trackId: z.string(),
    url: z.string(),
  })
  .meta({ id: "DeezerResolved" });

const DeezerFailedSchema = z
  .object({
    error: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "DeezerFailed" });

export const backfillDeezer = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillDeezer",
    path: "/admin/backfill/deezer",
    summary: "Back-fill Deezer track ids over certified + catalogue rows by exact ISRC",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      dryRun: z.boolean(),
      failed: z.array(DeezerFailedSchema),
      failedCount: z.number(),
      ok: z.literal(true),

      rateLimited: z.boolean(),
      resolved: z.array(DeezerResolvedSchema),
      resolvedCount: z.number(),

      unresolved: z.array(z.string()),
      unresolvedCount: z.number(),

      unvouchable: z.array(z.string()),
      unvouchableCount: z.number(),
    }),
  );

export const backfillLabelReleases = oc
  .route({
    method: "POST",
    operationId: "backfillLabelReleases",
    path: "/admin/backfill/label-releases",
    summary: "Tap Spotify's fresh releases for enabled seed labels into catalogue rows (bounded)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      dryRun: z.boolean().default(false),
      limit: z.coerce.number().int().min(1).max(200).default(5),
    }),
  )
  .output(
    z.object({
      albumsMatched: z.number(),

      albumsSeen: z.number(),

      budgetPaused: z.boolean(),

      configured: z.boolean(),
      dryRun: z.boolean(),

      failedFetches: z.number(),

      failedLabels: z.array(z.string()),

      fetchCeilingHit: z.boolean(),

      labelSlugs: z.array(z.string()),

      labelsProbed: z.number(),

      newRows: z.number(),

      newTrackIds: z.array(z.string()),
      ok: z.literal(true),

      rateLimited: z.boolean(),

      skippedKnown: z.number(),

      skippedUndated: z.number(),

      skippedUngrounded: z.number(),

      tracksSkippedArtistRule: z.number().optional(),
    }),
  );

const LabelImagesBackfillFailedSchema = z
  .object({
    error: z.string(),
    slug: z.string(),
  })
  .meta({ id: "LabelImagesBackfillFailed" });

export const backfillLabelImages = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillLabelImages",
    path: "/admin/backfill/label-images",
    summary: "Resolve label logos (Discogs → Wikidata) into R2 for existing labels (batched)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      body: z
        .object({
          discogsCandidates: DiscogsLabelCandidateBatchSchema.optional(),
        })
        .optional(),
      query: z.object({
        boxFetch: z.string().optional(),
        cursor: z.string().optional(),
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      discogsWork: z.array(DiscogsLabelWorkSchema).max(DISCOGS_LABEL_WORK_LIMIT),
      dryRun: z.boolean(),
      failed: z.array(LabelImagesBackfillFailedSchema),
      failedCount: z.number(),
      nextCursor: z.string().nullable(),

      none: z.array(z.string()),
      noneCount: z.number(),
      ok: z.literal(true),

      rateLimited: z.boolean(),
      resolved: z.array(z.string()),
      resolvedCount: z.number(),
    }),
  );

const LabelLineageBackfillFailedSchema = z
  .object({
    error: z.string(),
    slug: z.string(),
  })
  .meta({ id: "LabelLineageBackfillFailed" });

export const backfillLabelLineage = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillLabelLineage",
    path: "/admin/backfill/label-lineage",
    summary:
      "Resolve label lineage (founding date, place, parent imprint) from MusicBrainz (batched)",
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
      failed: z.array(LabelLineageBackfillFailedSchema),
      failedCount: z.number(),
      nextCursor: z.string().nullable(),

      none: z.array(z.string()),
      noneCount: z.number(),
      ok: z.literal(true),

      rateLimited: z.boolean(),
      resolved: z.array(z.string()),
      resolvedCount: z.number(),

      unmatchedParents: z.number(),
    }),
  );

const CoverMastersFailedSchema = z
  .object({
    error: z.string(),
    slug: z.string(),
  })
  .meta({ id: "CoverMastersFailed" });

export const backfillCoverMasters = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillCoverMasters",
    path: "/admin/backfill/cover-masters",
    summary: "Resolve owned ≤1200² cover masters (album/artist) into R2 (batched)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        cursor: z.string().optional(),
        dryRun: z.string().optional(),

        kind: z.string().optional(),
        limit: z.string().optional(),

        retry: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      dryRun: z.boolean(),
      failed: z.array(CoverMastersFailedSchema),
      failedCount: z.number(),

      kind: z.enum(["album", "artist"]),
      nextCursor: z.string().nullable(),

      none: z.array(z.string()),
      noneCount: z.number(),
      ok: z.literal(true),

      rateLimited: z.boolean(),

      requeued: z.array(z.string()).optional(),
      requeuedCount: z.number().optional(),
      resolved: z.array(z.string()),
      resolvedCount: z.number(),
    }),
  );

const RecordingMbidsFailedSchema = z
  .object({
    error: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "RecordingMbidsBackfillFailed" });

export const backfillRecordingMbids = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillRecordingMbids",
    path: "/admin/backfill/recording-mbids",
    summary:
      "Fill MusicBrainz recording MBIDs (crawler PK strip + ISRC resolve) over tracks (batched)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        cursor: z.string().optional(),
        dryRun: z.string().optional(),

        isrcRefreshLimit: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      dryRun: z.boolean(),
      failed: z.array(RecordingMbidsFailedSchema),
      failedCount: z.number(),

      isrcRefreshMissed: z.array(z.string()),
      isrcRefreshMissedCount: z.number(),

      isrcRefreshed: z.array(z.string()),
      isrcRefreshedCount: z.number(),

      missed: z.array(z.string()),
      missedCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),

      prefixStripped: z.number(),

      rateLimited: z.boolean(),
      resolved: z.array(z.string()),
      resolvedCount: z.number(),
    }),
  );

export const backfillArtistEdges = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillArtistEdges",
    path: "/admin/backfill/artist-edges",
    summary: "Fold artists_json names onto existing artist identities → track_artists (batched)",
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

      edgesWritten: z.number(),

      fullyMatched: z.array(z.string()),
      fullyMatchedCount: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),

      partiallyMatched: z.array(z.string()),
      partiallyMatchedCount: z.number(),

      queueDepth: z.number(),

      scanned: z.number(),

      unmatchedNames: z.number(),

      zeroMatched: z.array(z.string()),
      zeroMatchedCount: z.number(),
    }),
  );

export const backfillArtistCredits = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "backfillArtistCredits",
    path: "/admin/backfill/artist-credits",
    summary:
      "Mint identity-true artists from MusicBrainz credits for slice 0's zero-matched residual (batched)",
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
      adoptedArtists: z.number(),
      dryRun: z.boolean(),

      edgesWritten: z.number(),

      matchedArtists: z.number(),

      mintedArtists: z.number(),
      nextCursor: z.string().nullable(),
      ok: z.literal(true),

      rateLimited: z.boolean(),

      scanned: z.number(),

      skippedNoIdentity: z.number(),
    }),
  );

export const adminBackfillsContract = {
  backfill_apple_catalogue: backfillAppleCatalogue,
  backfill_apple_music: backfillAppleMusic,
  backfill_artist_credits: backfillArtistCredits,
  backfill_artist_edges: backfillArtistEdges,
  backfill_beatport: backfillBeatport,
  backfill_cover_masters: backfillCoverMasters,
  backfill_deezer: backfillDeezer,
  backfill_discogs: backfillDiscogs,
  backfill_discogs_facts: backfillDiscogsFacts,
  backfill_label_images: backfillLabelImages,
  backfill_label_lineage: backfillLabelLineage,
  backfill_label_releases: backfillLabelReleases,
  backfill_lastfm: backfillLastfm,
  backfill_recording_mbids: backfillRecordingMbids,
};
