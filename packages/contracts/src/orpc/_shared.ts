import * as z from "zod";

export const TrackFeaturesSchema = z
  .object({
    centroidHz: z.number().optional(),
    highRatio: z.number().optional(),
    midFlatness: z.number().optional(),
    onsetRate: z.number().optional(),
    subBassRatio: z.number().optional(),
  })
  .meta({ id: "TrackFeatures" });

export const TrackListItemSchema = z
  .object({
    addedAt: z.string(),
    addedToSpotify: z.boolean(),
    album: z.string().optional(),
    albumImageUrl: z.string().optional(),

    albumSlug: z.string().optional(),

    analyzedAt: z.string().optional(),

    analyzedFrom: z.enum(["preview", "full"]).optional(),

    appleMusicUrl: z.string().optional(),

    artistYoutubeChannelIds: z.array(z.string()).optional(),
    artists: z.array(z.string()),

    artworkMaxUrl: z.string().optional(),
    bpm: z.number().optional(),

    bpmSource: z.string().optional(),
    discogsReleaseUrl: z.string().optional(),
    durationMs: z.number(),
    enrichmentStatus: z.string(),
    features: TrackFeaturesSchema.optional(),

    galaxy: z
      .object({
        name: z.string(),
        slug: z.string(),
      })
      .optional(),
    isrc: z.string().optional(),
    key: z.string().optional(),

    keySource: z.string().optional(),
    label: z.string().optional(),

    labelSlug: z.string().optional(),
    logId: z.string().optional(),
    logPageUrl: z.string().optional(),

    mbRecordingId: z.string().optional(),
    note: z.string().optional(),

    observationAlignment: z
      .object({
        words: z.array(z.object({ endMs: z.number(), startMs: z.number(), text: z.string() })),
      })
      .optional(),
    observationAudioUrl: z.string().optional(),
    observationDurationMs: z.number().optional(),
    observationGeneratedAt: z.string().optional(),
    popularity: z.number().optional(),
    postedToTelegram: z.boolean(),
    previewUrl: z.string().optional(),
    releaseDate: z.string().optional(),
    similar: z.boolean().optional(),

    sourceAudioFailures: z.number().optional(),

    sourceAudioKey: z.string().optional(),
    spotifyUrl: z.string(),
    tiktokUrl: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
    type: z.literal("finding").optional(),
    updatedAt: z.string().optional(),
    videoGrain: z.string().optional(),
    videoModel: z.string().optional(),
    videoModelReasoning: z.string().optional(),
    videoPalette: z.string().optional(),
    videoPlateSubject: z.string().optional(),
    videoRegister: z.string().optional(),
    videoSquaredAt: z.string().optional(),
    videoStructure: z.string().optional(),
    videoUrl: z.string().optional(),
    videoVehicle: z.string().optional(),
    youtubeUrl: z.string().optional(),
  })
  .meta({ id: "TrackListItem" });

export const MixReasonSchema = z
  .object({
    kind: z.enum(["key", "bpm", "sonic"]),
    relationship: z.enum([
      "same_key",
      "relative",
      "adjacent",
      "energy",
      "diagonal",
      "distant",
      "tempo_match",
      "close_in_sound",
    ]),
  })
  .meta({ id: "MixReason" });

export const MixTrackSchema = z
  .object({
    albumImageUrl: z.string().optional(),

    appleMusicUrl: z.string().optional(),
    artists: z.array(z.string()),
    bpm: z.number().optional(),

    certified: z.boolean(),
    durationMs: z.number(),
    key: z.string().optional(),

    logId: z.string().optional(),

    spotifyUrl: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "MixTrack" });

export const MixCandidateSchema = MixTrackSchema.extend({
  reason: MixReasonSchema,
}).meta({ id: "MixCandidate" });

export const FreshTrackSchema = z
  .object({
    artists: z.array(z.string()),
    bpm: z.number().optional(),
    certified: z.boolean(),

    coverImageUrl: z.string().optional(),
    durationMs: z.number().optional(),
    key: z.string().optional(),

    logId: z.string().optional(),

    releaseDate: z.string(),
    spotifyUrl: z.string().optional(),
    title: z.string(),
  })
  .meta({ id: "FreshTrack" });

export const CatalogueTrackListItemSchema = z
  .object({
    album: z.string().optional(),

    albumSlug: z.string().optional(),
    artists: z.array(z.string()),
    certified: z.boolean(),

    coverImageUrl: z.string().optional(),
    label: z.string().optional(),

    labelSlug: z.string().optional(),

    logId: z.string().optional(),

    releaseDate: z.string().optional(),
    spotifyUrl: z.string().optional(),
    title: z.string(),

    trackId: z.string(),

    url: z.string().optional(),
  })
  .meta({ id: "CatalogueTrackListItem" });

export type CatalogueTrackListItem = z.infer<typeof CatalogueTrackListItemSchema>;

export const FreshAlbumSchema = z
  .object({
    artists: z.array(z.string()),
    coverImageUrl: z.string().optional(),
    name: z.string(),

    releaseDate: z.string(),

    slug: z.string(),
  })
  .meta({ id: "FreshAlbum" });

export const RadioNowPlayingSchema = z
  .object({
    currentTrack: TrackListItemSchema,
    nextTrack: TrackListItemSchema.optional(),
    offsetMs: z.number(),
    scheduleVersion: z.string(),
    serverEpochMs: z.number(),
    totalLoopDurationMs: z.number(),
    trackCount: z.number(),
  })
  .meta({ id: "RadioNowPlaying" });

const MixtapeMemberSchema = TrackListItemSchema.extend({
  startMs: z.number().optional(),
}).meta({ id: "MixtapeMember" });

export const MixtapeDTOSchema = z
  .object({
    addedAt: z.string().optional(),

    announcedAt: z.string().optional(),
    artists: z.tuple([z.literal("Fluncle")]),
    coverImageUrl: z.string().optional(),
    createdAt: z.string().optional(),
    durationMs: z.number().optional(),
    externalUrls: z.object({
      mixcloud: z.string().optional(),
      soundcloud: z.string().optional(),
      youtube: z.string().optional(),
    }),
    id: z.string().optional(),
    logId: z.string().optional(),
    memberCount: z.number(),
    members: z.array(MixtapeMemberSchema),
    note: z.string().optional(),
    publishedAt: z.string().optional(),
    recordedAt: z.string().optional(),

    recordingId: z.string().optional(),
    sequenceNumber: z.number().optional(),

    setVideoAt: z.string().optional(),

    status: z.enum(["distributing", "published"]),
    title: z.string(),
    type: z.literal("mixtape"),
    updatedAt: z.string().optional(),
  })
  .meta({ id: "MixtapeDTO" });

export const FeedItemSchema = z
  .union([TrackListItemSchema, MixtapeDTOSchema])
  .meta({ id: "FeedItem" });

export const TrackSearchResultSchema = z
  .object({
    album: z.string().optional(),
    artists: z.array(z.string()),
    artworkUrl: z.string().optional(),

    durationMs: z.number().optional(),
    id: z.string(),

    spotifyArtistIds: z.array(z.string()).optional(),
    spotifyUrl: z.string(),
    title: z.string(),
  })
  .meta({ id: "TrackSearchResult" });

export const PublicUserSchema = z
  .object({
    createdAt: z.string(),

    crewNumber: z.number().optional(),
    displayUsername: z.string().optional(),

    email: z.string(),

    emailVerified: z.boolean(),
    id: z.string(),

    image: z.string().optional(),

    name: z.string(),
    username: z.string().optional(),
  })
  .meta({ id: "PublicUser" });

export const SocialPostItemSchema = z
  .object({
    createdAt: z.string(),
    externalId: z.string().optional(),
    platform: z.string(),
    publishedAt: z.string().optional(),
    scheduledFor: z.string().optional(),
    status: z.string(),
    updatedAt: z.string(),
    url: z.string().optional(),
  })
  .meta({ id: "SocialPostItem" });

const EditionFindingRefSchema = z
  .object({
    logId: z.string(),
    why: z.string().optional(),
  })
  .meta({ id: "EditionFindingRef" });

const EditionGalaxyBlockSchema = z
  .object({
    findings: z.array(EditionFindingRefSchema),
    galaxy: z.string(),
  })
  .meta({ id: "EditionGalaxyBlock" });

const EditionTidbitSchema = z
  .object({
    source: z.string().optional(),
    text: z.string(),
  })
  .meta({ id: "EditionTidbit" });

export const EditionContentSchema = z
  .object({
    galaxies: z.array(EditionGalaxyBlockSchema).optional(),
    intro: z.string().optional(),
    mixtapeRef: z.string().optional(),
    tidbits: z.array(EditionTidbitSchema).optional(),
  })
  .meta({ id: "EditionContent" });

export const EditionDTOSchema = z
  .object({
    addedAt: z.string().optional(),
    content: EditionContentSchema,
    createdAt: z.string().optional(),
    id: z.string(),
    number: z.number().optional(),
    sentAt: z.string().optional(),
    status: z.enum(["draft", "sent"]),
    subject: z.string().optional(),
    updatedAt: z.string().optional(),
    windowSince: z.string().optional(),
    windowUntil: z.string().optional(),
  })
  .meta({ id: "EditionDTO" });

export const SubscriptionCategorySchema = z.enum([
  "infra",
  "AI",
  "media",
  "distribution",
  "domains",
  "tooling",
]);

export const SubscriptionCadenceSchema = z.enum(["monthly", "annual", "one-off", "usage"]);

export const SubscriptionStatusSchema = z.enum(["active", "cancelled", "trial"]);

export const SubscriptionDTOSchema = z
  .object({
    amount: z.number(),
    billingUrl: z.string().optional(),
    cadence: SubscriptionCadenceSchema,
    category: SubscriptionCategorySchema,
    createdAt: z.string(),
    currency: z.string(),
    id: z.string(),
    name: z.string(),
    notes: z.string().optional(),
    powers: z.string().optional(),
    renewsAt: z.string().optional(),
    status: SubscriptionStatusSchema,
    updatedAt: z.string(),
    vendor: z.string(),
  })
  .meta({ id: "SubscriptionDTO" });

export const ClipDTOSchema = z
  .object({
    caption: z.string().optional(),
    createdAt: z.string(),
    id: z.string(),
    inMs: z.number(),
    outMs: z.number(),

    recordingId: z.string().optional(),
    status: z.enum(["done", "pending"]),
    updatedAt: z.string(),
    xOffset: z.number(),
  })
  .meta({ id: "ClipDTO" });

export type ClipDTO = z.infer<typeof ClipDTOSchema>;

export const RecordingTracklistItemSchema = z
  .object({
    artists: z.array(z.string()),

    findingId: z.string().optional(),
    id: z.string(),
    startMs: z.number().optional(),
    title: z.string(),
  })
  .meta({ id: "RecordingTracklistItem" });

export type RecordingTracklistItem = z.infer<typeof RecordingTracklistItemSchema>;

export const RecordingDTOSchema = z
  .object({
    createdAt: z.string(),
    durationMs: z.number().optional(),

    hasVideo: z.boolean(),
    id: z.string(),

    logId: z.string().optional(),

    mixtapeId: z.string().optional(),

    parentId: z.string().optional(),

    plannedFor: z.string().optional(),

    r2Key: z.string().optional(),
    recordedAt: z.string().optional(),
    title: z.string(),
    tracklist: z.array(RecordingTracklistItemSchema),
    updatedAt: z.string(),

    version: z.number(),
  })
  .meta({ id: "RecordingDTO" });

export type RecordingDTO = z.infer<typeof RecordingDTOSchema>;

export const MixtapeSocialPostItemSchema = z
  .object({
    createdAt: z.string(),
    externalId: z.string().optional(),
    platform: z.string(),
    publishedAt: z.string().optional(),
    status: z.string(),
    updatedAt: z.string(),
    url: z.string().optional(),
  })
  .meta({ id: "MixtapeSocialPostItem" });

export const SubmissionSchema = z
  .object({
    album: z.string().optional(),
    artists: z.array(z.string()),
    artworkUrl: z.string().optional(),
    contact: z.string().optional(),
    createdAt: z.string(),
    id: z.string(),
    note: z.string().optional(),
    reviewedAt: z.string().optional(),
    source: z.enum(["cli", "ssh", "web"]),
    spotifyTrackId: z.string(),
    spotifyUrl: z.string(),
    status: z.enum(["approved", "pending", "rejected"]),
    title: z.string(),

    triageVerdict: z.string().optional(),
  })
  .meta({ id: "Submission" });

export const UploadContentTypeSchema = z
  .string()
  .max(128)
  .regex(/^video\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/, "Must be a video/* content type");
