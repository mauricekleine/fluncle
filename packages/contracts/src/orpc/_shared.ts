// Shared oRPC contract schemas — the Zod mirrors of the pure-types DTOs in
// `../index.ts`, kept structurally in lock-step with those types. Every domain
// contract module (`./tracks.ts`, `./health.ts`, …) imports the shapes it needs
// from here, so a DTO has exactly one Zod definition across the registry and the
// generated OpenAPI components stay deduplicated (`.meta({ id })`).
//
// Where a future op needs the full TS shape, derive it from the schema
// (`z.infer`) rather than maintaining two copies.

import * as z from "zod";

/** Enrichment's track-level spectral summary (`TrackFeatures` in ../index.ts). */
export const TrackFeaturesSchema = z
  .object({
    centroidHz: z.number().optional(),
    highRatio: z.number().optional(),
    midFlatness: z.number().optional(),
    onsetRate: z.number().optional(),
    subBassRatio: z.number().optional(),
  })
  .meta({ id: "TrackFeatures" });

/** A finding as the feed/log/admin board renders it (`TrackListItem` in ../index.ts). */
export const TrackListItemSchema = z
  .object({
    addedAt: z.string(),
    addedToSpotify: z.boolean(),
    album: z.string().optional(),
    albumImageUrl: z.string().optional(),
    artists: z.array(z.string()),
    bpm: z.number().optional(),
    discogsReleaseUrl: z.string().optional(),
    durationMs: z.number(),
    enrichmentStatus: z.string(),
    features: TrackFeaturesSchema.optional(),
    galaxy: z
      .object({
        key: z.enum(["astral", "lunar", "nebular", "solar"]),
        name: z.string(),
      })
      .optional(),
    isrc: z.string().optional(),
    key: z.string().optional(),
    label: z.string().optional(),
    logId: z.string().optional(),
    logPageUrl: z.string().optional(),
    note: z.string().optional(),
    // Word-level caption timings for the spoken observation (ms windows), driving the
    // synced subtitles on the radio player. Present only once captured (a fresh
    // Cartesia timestamped render or a forced-alignment backfill); absent ⇒ no captions.
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
    spotifyUrl: z.string(),
    tiktokUrl: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
    type: z.literal("finding").optional(),
    updatedAt: z.string().optional(),
    vibeX: z.number().optional(),
    vibeY: z.number().optional(),
    videoGrain: z.string().optional(),
    videoModel: z.string().optional(),
    videoModelReasoning: z.string().optional(),
    videoSquaredAt: z.string().optional(),
    videoUrl: z.string().optional(),
    videoVehicle: z.string().optional(),
    youtubeUrl: z.string().optional(),
  })
  .meta({ id: "TrackListItem" });

/**
 * The radio.fluncle.com now-playing slot (`RadioNowPlaying` in ../index.ts; RFC
 * radio-broadcast.md Unit A). The server-authoritative position on the shared loop
 * — `currentTrack` + `offsetMs` is what's playing right now; `nextTrack` the
 * preload target (offset 0); `serverEpochMs` + `scheduleVersion` drive the
 * client's NTP-lite skew + the re-fetch on a changed catalogue.
 */
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

/** A per-platform distribution row (`MixtapeMember`-adjacent; see ../index.ts). */
const MixtapeMemberSchema = TrackListItemSchema.extend({
  startMs: z.number().optional(),
}).meta({ id: "MixtapeMember" });

/** A mixtape as `/mixtapes` + `/api/mixtapes` emit it (`MixtapeDTO` in ../index.ts). */
export const MixtapeDTOSchema = z
  .object({
    addedAt: z.string().optional(),
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
    plannedFor: z.string().optional(),
    publishedAt: z.string().optional(),
    recordedAt: z.string().optional(),
    // The coordinate a DRAFT will mint into — reserved from its live session (or
    // recorded date) so the operator can name their Beatport playlist / USB folders
    // with it before recording. Present only on a draft with a date basis; a minted
    // mixtape carries the real `logId` instead. Kept in lock-step with the mint.
    reservedLogId: z.string().optional(),
    sequenceNumber: z.number().optional(),
    // Set (ISO) once the full set video is uploaded to R2 — the `/log` page then
    // shows the branded scrubber player. Absent ⇒ no set video yet.
    setVideoAt: z.string().optional(),
    status: z.enum(["distributing", "draft", "published"]),
    title: z.string(),
    type: z.literal("mixtape"),
    updatedAt: z.string().optional(),
  })
  .meta({ id: "MixtapeDTO" });

/**
 * A feed item: a finding or a mixtape (`FeedItem` in ../index.ts). The merged
 * `/tracks` feed interleaves both; a mixtape is distinguished by `type:
 * "mixtape"`. The `TrackListItem` arm stays first so a finding (whose `type` is
 * an OPTIONAL `"finding"`) still matches when `type` is absent.
 */
export const FeedItemSchema = z
  .union([TrackListItemSchema, MixtapeDTOSchema])
  .meta({ id: "FeedItem" });

/** A Spotify search candidate (`TrackSearchResult` in ../index.ts; `/api/search`). */
export const TrackSearchResultSchema = z
  .object({
    album: z.string().optional(),
    artists: z.array(z.string()),
    artworkUrl: z.string().optional(),
    id: z.string(),
    spotifyUrl: z.string(),
    title: z.string(),
  })
  .meta({ id: "TrackSearchResult" });

/**
 * A signed-in public user as the `/me` private tier returns it (`PublicUser` in
 * the server `public-auth` module). The cookie-session identity — distinct from
 * the admin grant. `username`/`displayUsername` are absent until the user claims
 * a handle, so both are optional.
 */
export const PublicUserSchema = z
  .object({
    createdAt: z.string(),
    displayUsername: z.string().optional(),
    id: z.string(),
    username: z.string().optional(),
  })
  .meta({ id: "PublicUser" });

/** A per-platform publication row (`SocialPostItem` in ../index.ts; `social_posts`). */
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

/**
 * A finding reference inside an edition's content payload — the finding's own Log
 * ID plus the editorial "why" line written FOR this edition (which may differ from
 * the finding's own `note`). The archive page hydrates the live finding from
 * `tracks` by `logId`, so the reference stays tiny and current.
 */
const EditionFindingRefSchema = z
  .object({
    logId: z.string(),
    why: z.string().optional(),
  })
  .meta({ id: "EditionFindingRef" });

/** A galaxy-grouped block of finding references inside an edition. */
const EditionGalaxyBlockSchema = z
  .object({
    findings: z.array(EditionFindingRefSchema),
    galaxy: z.string(),
  })
  .meta({ id: "EditionGalaxyBlock" });

/** A tidbit (a linkable fact) carried in an edition. */
const EditionTidbitSchema = z
  .object({
    source: z.string().optional(),
    text: z.string(),
  })
  .meta({ id: "EditionTidbit" });

/**
 * The structured content payload an edition stores (`editions.content_json`). The
 * SINGLE source the agent authors that renders BOTH the web archive page and the
 * email HTML. LOOSE on the
 * agent's side at write time (the admin route passes it through), but this is the
 * canonical READ shape the public DTO exposes.
 */
export const EditionContentSchema = z
  .object({
    galaxies: z.array(EditionGalaxyBlockSchema).optional(),
    intro: z.string().optional(),
    mixtapeRef: z.string().optional(),
    tidbits: z.array(EditionTidbitSchema).optional(),
  })
  .meta({ id: "EditionContent" });

/**
 * An edition as the `/newsletter` archive surface + `/api/v1/newsletter/editions`
 * emit it (`EditionDTO` in ../index.ts). NOT a collectible: a plain integer
 * `number` (minted on send, absent on a draft), no Log ID, no coordinate. The
 * `content` is the structured payload above.
 */
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

/**
 * A clip — a lightweight 9:16 derivative cut from a mixtape's set video
 * (`mixtape_clips`; `ClipDTO` below). NOT a spine
 * object: it carries no Log ID. Many per mixtape (the drip-feed backlog). This is the
 * wire shape the clip ops emit and the editor / clip library read. `xOffset` is the
 * 9:16 framing offset; `status` is the cut-queue + library-filter state.
 */
export const ClipDTOSchema = z
  .object({
    caption: z.string().optional(),
    createdAt: z.string(),
    id: z.string(),
    inMs: z.number(),
    // The mixtape a LEGACY clip was cut from (its published set). Under the RFC
    // recording-primitive (Design B) a NEW clip is cut from a `recording` instead, so
    // this is now OPTIONAL: a recording clip carries `recordingId` and no `mixtapeId`.
    mixtapeId: z.string().optional(),
    outMs: z.number(),
    // The `recording` a clip was cut from (the RFC recording-primitive path). Set on
    // every new clip; absent on a legacy mixtape clip. The cut prefers this over
    // `mixtapeId`.
    recordingId: z.string().optional(),
    status: z.enum(["done", "pending"]),
    updatedAt: z.string(),
    xOffset: z.number(),
  })
  .meta({ id: "ClipDTO" });

/** The TS shape of a clip, derived from the schema (one definition, no drift). */
export type ClipDTO = z.infer<typeof ClipDTOSchema>;

/**
 * A recording tracklist cue (`recordings.tracklist_json`; RFC recording-primitive,
 * Design B). `id` is a stable cue ref; `artists`/`title` feed the clip overlay's
 * changing on-screen Track-ID (`resolveClipTracks`) with no re-splitting, and seed
 * `mixtape_tracks` on promote. `startMs` is the cue's start on the set timeline.
 */
export const RecordingTracklistItemSchema = z
  .object({
    artists: z.array(z.string()),
    id: z.string(),
    startMs: z.number().optional(),
    title: z.string(),
  })
  .meta({ id: "RecordingTracklistItem" });

/** The TS shape of a recording tracklist cue, derived from the schema. */
export type RecordingTracklistItem = z.infer<typeof RecordingTracklistItemSchema>;

/**
 * A RECORDING — a captured DJ set that is NOT (yet) a published mixtape (RFC
 * recording-primitive, Design B). It OWNS its R2 key (`r2Key`) and carries an optional
 * cue tracklist. Coordinate-less until `promote` mints a mixtape from it; `logId` +
 * `mixtapeId` are then the promoted mixtape's coordinate + id (absent while un-promoted).
 */
export const RecordingDTOSchema = z
  .object({
    createdAt: z.string(),
    durationMs: z.number().optional(),
    id: z.string(),
    // The promoted mixtape's committed Log ID coordinate (absent until promoted).
    logId: z.string().optional(),
    // The promoted mixtape's id (absent until promoted).
    mixtapeId: z.string().optional(),
    r2Key: z.string(),
    recordedAt: z.string().optional(),
    title: z.string(),
    tracklist: z.array(RecordingTracklistItemSchema),
    updatedAt: z.string(),
  })
  .meta({ id: "RecordingDTO" });

/** The TS shape of a recording, derived from the schema (one definition, no drift). */
export type RecordingDTO = z.infer<typeof RecordingDTOSchema>;

/** A mixtape per-platform distribution row (`MixtapeSocialPostItem`; `mixtape_social_posts`). */
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

/** A finding submission as `/api/submissions` records it (`Submission` in ../index.ts). */
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
  })
  .meta({ id: "Submission" });
