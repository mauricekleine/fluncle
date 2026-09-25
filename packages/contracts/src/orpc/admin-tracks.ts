import { oc } from "@orpc/contract";
import * as z from "zod";

import { FeedItemSchema, MixReasonSchema, TrackListItemSchema } from "./_shared.js";

const UpdateTrackBodySchema = z.looseObject({
  analyzedAt: z.unknown().optional(),
  analyzedFrom: z.unknown().optional(),
  bpm: z.unknown().optional(),
  bpmConfidence: z.unknown().optional(),
  bpmSource: z.unknown().optional(),

  captureStatus: z.unknown().optional(),

  captureVerification: z.unknown().optional(),
  captureVerifiedAt: z.unknown().optional(),

  embedding: z.unknown().optional(),
  enrichmentStatus: z.unknown().optional(),
  features: z.unknown().optional(),

  galaxyId: z.unknown().optional(),
  isrc: z.unknown().optional(),
  key: z.unknown().optional(),
  keyConfidence: z.unknown().optional(),
  keySource: z.unknown().optional(),
  logId: z.unknown().optional(),
  note: z.unknown().optional(),
  sourceAudioAttemptedAt: z.unknown().optional(),
  sourceAudioBytes: z.unknown().optional(),
  sourceAudioCapturedAt: z.unknown().optional(),
  sourceAudioFailures: z.unknown().optional(),
  sourceAudioKey: z.unknown().optional(),

  sourceAudioRejected: z.unknown().optional(),

  sourceVerification: z.unknown().optional(),
  videoUrl: z.unknown().optional(),

  youtubeReverdict: z.unknown().optional(),

  youtubeVerification: z.unknown().optional(),

  youtubeVideoId: z.unknown().optional(),
});

const ObserveTrackBodySchema = z.looseObject({
  contextNote: z.unknown().optional(),
  durationMs: z.unknown().optional(),
  durationTargetSec: z.unknown().optional(),

  force: z.unknown().optional(),

  promptVersion: z.number().int().min(0).optional(),
  script: z.unknown().optional(),
  voiceId: z.unknown().optional(),
});

const ContextTrackBodySchema = z.looseObject({
  query: z.unknown().optional(),
  refresh: z.unknown().optional(),
});

const NoteTrackBodySchema = z.looseObject({
  dryRun: z.unknown().optional(),
  note: z.unknown().optional(),

  promptVersion: z.number().int().min(0).optional(),
});

const NoteEchoSchema = z.object({
  logId: z.string().nullable(),
  overlap: z.number(),
  phrase: z.string(),
});

const PresignVideoUploadsBodySchema = z.looseObject({
  fields: z.unknown().optional(),
});

const FinalizeVideoBodySchema = z.looseObject({
  squared: z.unknown().optional(),
  videoGrain: z.unknown().optional(),
  videoModel: z.unknown().optional(),
  videoModelReasoning: z.unknown().optional(),
  videoPalette: z.unknown().optional(),

  videoPlateSubject: z.unknown().optional(),
  videoRegister: z.unknown().optional(),
  videoStructure: z.unknown().optional(),
  videoVehicle: z.unknown().optional(),
});

const VideoUploadSchema = z
  .object({
    contentType: z.string(),
    field: z.string(),
    key: z.string(),
    url: z.string(),
  })
  .meta({ id: "VideoUpload" });

export const updateTrack = oc
  .route({
    method: "PATCH",
    operationId: "updateTrack",
    path: "/admin/tracks/{trackId}",
    summary: "Update a track's enrichment/curation fields (role-gated per field)",
    tags: ["Admin"],
  })
  .input(UpdateTrackBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      fields: z.array(z.string()),
      ok: z.literal(true),
      trackId: z.string(),
    }),
  );

const CaptureReconciliationKindSchema = z.enum([
  "capture",
  "youtube-provenance",
  "youtube-reverdict",
]);

const CaptureExternalResultSchema = z.union([
  z.discriminatedUnion("outcome", [
    z.strictObject({
      attemptedAt: z.string().datetime({ offset: true }),
      kind: z.literal("capture"),
      outcome: z.enum(["failed", "unmatched"]),
      sourceAudioRejected: z.string().max(16_384).optional(),
    }),
    z.strictObject({
      attemptedAt: z.string().datetime({ offset: true }),
      bytes: z.number().int().min(1),

      captureVerification: z.enum([
        "consensus-verified",
        "operator-verified",
        "preview-match",
        "unverified",
      ]),
      capturedAt: z.string().datetime({ offset: true }),
      kind: z.literal("capture"),
      outcome: z.literal("done"),
      sourceAudioKey: z.string().min(1).max(1024),
      sourceAudioRejected: z.string().max(16_384).optional(),
      verifiedAt: z.string().datetime({ offset: true }),
      youtubeVideoId: z.string().min(1).max(128).optional(),
    }),
  ]),
  z.discriminatedUnion("outcome", [
    z.strictObject({
      kind: z.literal("youtube-provenance"),
      outcome: z.literal("none"),
      verification: z.enum(["inconclusive", "no-match"]),
    }),
    z.strictObject({
      kind: z.literal("youtube-provenance"),
      outcome: z.literal("source-found"),
      sourceVerification: z.enum(["soundcloud-archive-match", "soundcloud-preview-match"]),
    }),
    z.strictObject({
      kind: z.literal("youtube-provenance"),
      outcome: z.literal("youtube-found"),
      verification: z.enum(["archive-match", "metadata-match", "preview-match"]),
      youtubeVideoId: z.string().min(1).max(128),
    }),
  ]),
  z.strictObject({ kind: z.literal("youtube-reverdict"), outcome: z.literal("reverdict") }),
]);

const CaptureReceiptCoordinatesSchema = z.strictObject({
  operationId: z.literal("track.capture"),
  operationKey: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._~:/-]*$/),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

const CapturePreparedTrackSchema = z.strictObject({
  analyzedFrom: z.enum(["full", "preview"]).optional(),

  anchored: z.boolean().optional(),
  artists: z.array(z.string().max(512)).max(64),
  bpm: z.number().optional(),

  captureSourcePin: z.string().max(64).optional(),

  captureSourcePinAllowDuration: z.boolean().optional(),
  certified: z.boolean(),
  durationMs: z.number().int().min(1).optional(),
  label: z.string().max(1024).optional(),
  logId: z.string().max(64).optional(),
  sourceAudioFailures: z.number().int().min(0).optional(),
  sourceAudioKey: z.string().max(1024).optional(),
  sourceAudioRejected: z.string().max(16_384).optional(),
  title: z.string().max(2048),
  trackId: z.string().min(1).max(256),
});

const CaptureCommittedReceiptResultSchema = z.union([
  z.strictObject({
    applied: z.literal(true),
    kind: z.literal("capture"),
    outcome: z.enum(["done", "failed", "unmatched"]),
  }),
  z.strictObject({
    applied: z.literal(true),
    kind: z.literal("youtube-provenance"),
    outcome: z.enum(["none", "source-found", "youtube-found"]),
  }),
  z.strictObject({
    applied: z.literal(true),
    kind: z.literal("youtube-reverdict"),
    outcome: z.literal("reverdict"),
  }),
]);

const CaptureRejectedReceiptResultSchema = z.strictObject({
  applied: z.literal(false),
  reason: z.literal("stale"),
});

export const prepareTrackCapture = oc
  .route({
    method: "POST",
    operationId: "prepareTrackCapture",
    path: "/admin/tracks/{trackId}/capture/prepare",
    summary: "Prepare a current capture reconciliation snapshot",
    tags: ["Admin"],
  })
  .input(
    z.strictObject({
      kind: CaptureReconciliationKindSchema,
      priorSnapshotToken: z.string().min(1).max(65_536).optional(),
      trackId: z.string().min(1).max(256),
    }),
  )
  .output(
    z.discriminatedUnion("prepared", [
      z.strictObject({
        ok: z.literal(true),
        prepared: z.literal(false),
        reason: z.enum(["ineligible", "not-found", "stale"]),
      }),
      z.strictObject({
        ok: z.literal(true),
        prepared: z.literal(true),
        snapshotToken: z.string().min(1).max(65_536),
        track: CapturePreparedTrackSchema,
      }),
    ]),
  );

export const authorizeTrackCapture = oc
  .route({
    method: "POST",
    operationId: "authorizeTrackCapture",
    path: "/admin/tracks/{trackId}/capture/authorize",
    summary: "Authorize a prepared capture result",
    tags: ["Admin"],
  })
  .input(
    z.strictObject({
      result: CaptureExternalResultSchema,
      snapshotToken: z.string().min(1).max(65_536),
      trackId: z.string().min(1).max(256),
    }),
  )
  .output(
    CaptureReceiptCoordinatesSchema.extend({
      commitToken: z.string().min(1).max(65_536),
      ok: z.literal(true),
    }),
  );

export const commitTrackCapture = oc
  .route({
    method: "POST",
    operationId: "commitTrackCapture",
    path: "/admin/tracks/{trackId}/capture/commit",
    summary: "Commit a prepared capture result",
    tags: ["Admin"],
  })
  .input(
    CaptureReceiptCoordinatesSchema.extend({
      commitToken: z.string().min(1).max(65_536),
      trackId: z.string().min(1).max(256),
    }),
  )
  .output(
    z.discriminatedUnion("outcome", [
      z.strictObject({
        ok: z.literal(true),
        outcome: z.literal("committed"),
        replayed: z.boolean(),
        result: CaptureCommittedReceiptResultSchema,
      }),
      z.strictObject({
        ok: z.literal(true),
        outcome: z.literal("rejected"),
        replayed: z.boolean(),
        result: CaptureRejectedReceiptResultSchema,
      }),
      z.strictObject({
        ok: z.literal(true),
        outcome: z.enum(["conflict", "in-progress", "safely-retryable"]),
        replayed: z.boolean(),
      }),
    ]),
  );

export const MAX_CAPTURE_PREPARE_BATCH = 12;

export const MAX_CAPTURE_COMMIT_BATCH = 6;

export const MAX_EMBEDDING_WRITE_BATCH = 6;

export const EMBEDDING_DIMENSIONS = 1024;

const TrackWorkCapabilitiesSchema = z.strictObject({
  commitTrackCaptures: z.number().int().min(1).max(MAX_CAPTURE_COMMIT_BATCH).optional(),
  prepareTrackCaptures: z.number().int().min(1).max(MAX_CAPTURE_PREPARE_BATCH).optional(),
  updateTrackEmbeddings: z.number().int().min(1).max(MAX_EMBEDDING_WRITE_BATCH).optional(),
});

const ItemElapsedMsSchema = z.number().int().min(0).optional();

const CapturePreparedItemSchema = z.union([
  z.strictObject({
    elapsedMs: ItemElapsedMsSchema,
    prepared: z.literal(false),
    reason: z.enum(["deferred", "ineligible", "not-found", "stale"]),
    trackId: z.string().min(1).max(256),
  }),
  z.strictObject({
    elapsedMs: ItemElapsedMsSchema,
    prepared: z.literal(true),
    snapshotToken: z.string().min(1).max(65_536),
    track: CapturePreparedTrackSchema,
    trackId: z.string().min(1).max(256),
  }),
]);

export const prepareTrackCaptures = oc
  .route({
    method: "POST",
    operationId: "prepareTrackCaptures",
    path: "/admin/tracks/captures/prepare",
    summary: "Prepare a batch of capture reconciliation snapshots in one admitted phase",
    tags: ["Admin"],
  })
  .input(
    z.strictObject({
      items: z
        .array(
          z.strictObject({
            kind: CaptureReconciliationKindSchema,
            priorSnapshotToken: z.string().min(1).max(65_536).optional(),
            trackId: z.string().min(1).max(256),
          }),
        )
        .min(1)
        .max(MAX_CAPTURE_PREPARE_BATCH),

      reservedThisTick: z.number().int().min(0).max(10_000).optional(),
    }),
  )
  .output(
    z.strictObject({
      deferred: z.number().int().min(0),
      ok: z.literal(true),

      reserved: z.number().int().min(0),

      results: z.array(CapturePreparedItemSchema).max(MAX_CAPTURE_PREPARE_BATCH),
    }),
  );

const CaptureCommitReceiptSchema = z
  .object({
    elapsedMs: ItemElapsedMsSchema,

    error: z.string().max(500).optional(),
    outcome: z.enum([
      "committed",
      "conflict",
      "failed",
      "in-progress",
      "lookup-failed",
      "rejected",
      "safely-retryable",
    ]),
    replayed: z.boolean(),
    result: z
      .union([CaptureCommittedReceiptResultSchema, CaptureRejectedReceiptResultSchema])
      .optional(),
    trackId: z.string().min(1).max(256),
  })
  .meta({ id: "CaptureCommitReceipt" });

export const commitTrackCaptures = oc
  .route({
    method: "POST",
    operationId: "commitTrackCaptures",
    path: "/admin/tracks/captures/commit",
    summary: "Commit a batch of prepared capture results in one admitted phase",
    tags: ["Admin"],
  })
  .input(
    z.strictObject({
      items: z
        .array(
          CaptureReceiptCoordinatesSchema.extend({
            commitToken: z.string().min(1).max(65_536),
            trackId: z.string().min(1).max(256),
          }),
        )
        .min(1)
        .max(MAX_CAPTURE_COMMIT_BATCH),
    }),
  )
  .output(
    z.strictObject({
      deferred: z.number().int().min(0),
      ok: z.literal(true),

      receipts: z.array(CaptureCommitReceiptSchema).max(MAX_CAPTURE_COMMIT_BATCH),
    }),
  );

export const updateTrackEmbeddings = oc
  .route({
    method: "POST",
    operationId: "updateTrackEmbeddings",
    path: "/admin/tracks/embeddings",
    summary: "Write a batch of audio embeddings in one admitted phase",
    tags: ["Admin"],
  })
  .input(
    z.strictObject({
      items: z
        .array(
          z.strictObject({
            embedding: z.array(z.number()).length(EMBEDDING_DIMENSIONS),
            trackId: z.string().min(1).max(256),
          }),
        )
        .min(1)
        .max(MAX_EMBEDDING_WRITE_BATCH),
    }),
  )
  .output(
    z.strictObject({
      deferred: z.number().int().min(0),
      ok: z.literal(true),

      results: z
        .array(
          z.strictObject({
            elapsedMs: ItemElapsedMsSchema,
            error: z.string().max(500).optional(),
            fields: z.array(z.string()).optional(),
            outcome: z.enum(["deferred", "failed", "updated"]),
            trackId: z.string().min(1).max(256),
          }),
        )
        .max(MAX_EMBEDDING_WRITE_BATCH),
    }),
  );

export const observeTrack = oc
  .route({
    method: "POST",
    operationId: "observeTrack",
    path: "/admin/tracks/{trackId}/observe",
    summary: "Mint a track's spoken audio-observation artifact",
    tags: ["Admin"],
  })
  .input(ObserveTrackBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      audioUrl: z.string(),
      durationMs: z.number(),
      generatedAt: z.string(),
      jsonUrl: z.string(),
      logId: z.string(),
      ok: z.literal(true),

      skipped: z.boolean().optional(),
      textUrl: z.string(),
      trackId: z.string(),
      voiceId: z.string(),
    }),
  );

export const contextTrack = oc
  .route({
    method: "POST",
    operationId: "contextTrack",
    path: "/admin/tracks/{trackId}/context",
    summary: "Fetch + store a track's factual context note (Firecrawl facts only)",
    tags: ["Admin"],
  })
  .input(ContextTrackBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      contextNote: z.string(),
      logId: z.string(),
      ok: z.literal(true),

      skipped: z.boolean().optional(),
      sources: z.array(z.string()),
      trackId: z.string(),
    }),
  );

export const noteTrack = oc
  .route({
    method: "POST",
    operationId: "noteTrack",
    path: "/admin/tracks/{trackId}/note",
    summary: "Auto-author a finding's editorial note (fills an empty note only)",
    tags: ["Admin"],
  })
  .input(NoteTrackBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      dryRun: z.literal(true).optional(),

      echo: NoteEchoSchema.optional(),
      logId: z.string(),

      neighbors: z.array(z.string()).optional(),
      note: z.string(),
      ok: z.literal(true),

      skipped: z.boolean().optional(),
      trackId: z.string(),
    }),
  );

export const presignTrackVideoUploads = oc
  .route({
    method: "POST",
    operationId: "presignTrackVideoUploads",
    path: "/admin/tracks/{trackId}/video/uploads",
    summary: "Presign direct-to-R2 PUT URLs for a track's video artifacts",
    tags: ["Admin"],
  })
  .input(PresignVideoUploadsBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      logId: z.string(),
      ok: z.literal(true),
      trackId: z.string(),
      uploads: z.array(VideoUploadSchema),
    }),
  );

export const finalizeTrackVideo = oc
  .route({
    method: "POST",
    operationId: "finalizeTrackVideo",
    path: "/admin/tracks/{trackId}/video/finalize",
    summary: "Finalize a track's uploaded video bundle (link the canonical cut)",
    tags: ["Admin"],
  })
  .input(FinalizeVideoBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      logId: z.string(),
      ok: z.literal(true),
      trackId: z.string(),
      videoUrl: z.string(),
    }),
  );

export const requeueVideo = oc
  .route({
    method: "POST",
    operationId: "requeueVideo",
    path: "/admin/tracks/{trackId}/video/requeue",
    summary: "Clear a finding's video so it re-enters the render queue (and off radio)",
    tags: ["Admin"],
  })
  .input(z.object({ trackId: z.string() }))
  .output(
    z.object({
      alreadyClear: z.boolean().optional(),
      logId: z.string(),
      ok: z.literal(true),
      trackId: z.string(),
    }),
  );

export const purgeVideo = oc
  .route({
    method: "POST",
    operationId: "purgeVideo",
    path: "/admin/tracks/{trackId}/video/purge",
    summary: "Purge a finding's stale Cloudflare video renditions from the edge",
    tags: ["Admin"],
  })
  .input(z.object({ trackId: z.string() }))
  .output(
    z.object({
      logId: z.string(),

      noVideo: z.boolean().optional(),
      ok: z.literal(true),
      trackId: z.string(),
    }),
  );

const CaptureSourcePinResultSchema = z
  .object({
    captureSourcePin: z.string().nullable(),

    captureSourcePinAllowDuration: z.boolean(),

    captureStatus: z.string(),

    logId: z.string().nullable(),
    ok: z.literal(true),
    trackId: z.string(),
  })
  .meta({ id: "CaptureSourcePinResult" });

export const pinCaptureSource = oc
  .route({
    method: "PUT",
    operationId: "pinCaptureSource",
    path: "/admin/tracks/{trackId}/capture-source",
    summary: "Pin the YouTube upload the capture sweep must download for a track",
    tags: ["Admin"],
  })
  .input(
    z.object({
      allowDurationMismatch: z.boolean().optional(),
      trackId: z.string(),

      youtubeVideoId: z.string().min(1).max(2_048),
    }),
  )
  .output(CaptureSourcePinResultSchema);

export const clearCaptureSource = oc
  .route({
    method: "DELETE",
    operationId: "clearCaptureSource",
    path: "/admin/tracks/{trackId}/capture-source",
    summary: "Clear a track's pinned capture source (the ladder runs again)",
    tags: ["Admin"],
  })
  .input(z.object({ trackId: z.string() }))
  .output(CaptureSourcePinResultSchema);

const PublishTrackResultSchema = z
  .object({
    addedToSpotify: z.boolean(),
    dryRun: z.boolean(),
    message: z.string(),
    postedToTelegram: z.boolean(),
    track: z.object({
      album: z.string().optional(),
      albumImageUrl: z.string().optional(),
      artists: z.array(z.string()),
      durationMs: z.number(),
      isrc: z.string().optional(),
      label: z.string().optional(),
      logId: z.string().optional(),
      logPageUrl: z.string().optional(),
      popularity: z.number().optional(),
      previewUrl: z.string().optional(),
      spotifyUrl: z.string(),
      title: z.string(),
      trackId: z.string(),
    }),
  })
  .meta({ id: "PublishTrackResult" });

export const getTrackAdmin = oc
  .route({
    method: "GET",
    operationId: "getTrackAdmin",
    path: "/admin/tracks/{trackId}",
    summary: "Get one finding with full admin fields (by Spotify trackId or Log ID)",
    tags: ["Admin"],
  })
  .input(z.object({ trackId: z.string() }))
  .output(z.object({ ok: z.literal(true), track: TrackListItemSchema }));

export const listTracksAdmin = oc
  .route({
    method: "GET",
    operationId: "listTracksAdmin",
    path: "/admin/tracks",
    summary: "Query the admin archive board (search or paginated list)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      captureQueue: z.string().optional(),
      cursor: z.string().optional(),

      hasContext: z.string().optional(),

      hasEmbedding: z.string().optional(),

      hasKey: z.string().optional(),
      hasNote: z.string().optional(),
      hasObservation: z.string().optional(),
      hasVideo: z.string().optional(),
      limit: z.string().optional(),
      order: z.string().optional(),
      q: z.string().optional(),

      retryEmptyContext: z.string().optional(),
      status: z.string().optional(),
    }),
  )
  .output(
    z.union([
      z.object({
        nextCursor: z.string().optional(),
        totalCount: z.number(),
        tracks: z.array(FeedItemSchema),
      }),
      z.object({ tracks: z.array(TrackListItemSchema) }),
    ]),
  );

export const TrackWorkKindSchema = z
  .enum([
    "analyze",
    "anchor",
    "capture",
    "embed",
    "isrc-recovery",
    "youtube-provenance",
    "youtube-reverdict",
  ])
  .meta({
    id: "TrackWorkKind",
  });

export const TrackWorkScopeSchema = z.enum(["all", "catalogue", "findings"]).meta({
  id: "TrackWorkScope",
});

export const TrackWorkItemSchema = z
  .object({
    analyzedFrom: z.enum(["full", "preview"]).optional(),

    anchorQuery: z.string().optional(),
    artistYoutubeChannelIds: z.array(z.string()).optional(),
    artists: z.array(z.string()),
    bpm: z.number().optional(),
    capturePriority: z.number().nullable(),

    captureSourcePin: z.string().optional(),

    captureSourcePinAllowDuration: z.boolean().optional(),
    certified: z.boolean(),

    deezerQuery: z.string().optional(),
    durationMs: z.number(),
    isrc: z.string().nullable(),
    label: z.string().nullable(),
    logId: z.string().nullable(),
    sourceAudioFailures: z.number().optional(),
    sourceAudioKey: z.string().nullable(),

    sourceAudioRejected: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "TrackWorkItem" });

export const listTrackWork = oc
  .route({
    method: "GET",
    operationId: "listTrackWork",
    path: "/admin/tracks/work",
    summary: "The audio pipeline's worklist for one stage, in capture-priority order",
    tags: ["Admin"],
  })
  .input(
    z.object({
      age: z.string().optional(),
      count: z.string().optional(),

      debtAware: z.string().optional(),
      kind: TrackWorkKindSchema,
      limit: z.coerce.number().int().min(1).max(250).default(50),
      paidMode: z.enum(["quota", "prior"]).optional(),
      scope: TrackWorkScopeSchema.default("all"),
    }),
  )
  .output(
    z.object({
      capabilities: TrackWorkCapabilitiesSchema.optional(),

      debtPending: z.boolean().optional(),
      ok: z.literal(true),
      oldestQueuedCaptureOver24h: z.boolean().optional(),

      queued: z.number().optional(),
      tracks: z.array(TrackWorkItemSchema),
    }),
  );

export const publishTrack = oc
  .route({
    method: "POST",
    operationId: "publishTrack",
    path: "/admin/tracks",
    summary: "Publish a finding from a Spotify URL",
    tags: ["Admin"],
  })
  .input(
    z.looseObject({
      dryRun: z.unknown().optional(),
      note: z.unknown().optional(),
      spotifyUrl: z.unknown().optional(),
    }),
  )
  .output(PublishTrackResultSchema.extend({ ok: z.literal(true) }));

const MixOrderStopSchema = z
  .object({
    artists: z.array(z.string()),
    bpm: z.number().optional(),
    flagged: z.boolean(),
    key: z.string().optional(),
    logId: z.string(),
    title: z.string(),
    transitionReason: MixReasonSchema.optional(),
    transitionScore: z.number().optional(),
  })
  .meta({ id: "MixOrderStop" });

export const getMixableOrder = oc
  .route({
    method: "GET",
    operationId: "getMixableOrder",
    path: "/admin/tracks/mixable-order",
    summary: "Order a pool of findings into a smooth proposed mix (Held-Karp / greedy+2-opt)",
    tags: ["Admin"],
  })
  .input(z.object({ ids: z.string(), seed: z.string().optional() }))
  .output(
    z.object({
      algorithm: z.enum(["held-karp", "greedy-2opt"]),
      ok: z.literal(true),
      order: z.array(MixOrderStopSchema),
      totalCost: z.number(),
    }),
  );

export const adminTracksContract = {
  authorize_track_capture: authorizeTrackCapture,
  clear_capture_source: clearCaptureSource,
  commit_track_capture: commitTrackCapture,
  commit_track_captures: commitTrackCaptures,
  context_track: contextTrack,
  finalize_track_video: finalizeTrackVideo,
  get_mixable_order: getMixableOrder,
  get_track_admin: getTrackAdmin,
  list_track_work: listTrackWork,
  list_tracks_admin: listTracksAdmin,
  note_track: noteTrack,
  observe_track: observeTrack,
  pin_capture_source: pinCaptureSource,
  prepare_track_capture: prepareTrackCapture,
  prepare_track_captures: prepareTrackCaptures,
  presign_track_video_uploads: presignTrackVideoUploads,
  publish_track: publishTrack,
  purge_video: purgeVideo,
  requeue_video: requeueVideo,
  update_track: updateTrack,
  update_track_embeddings: updateTrackEmbeddings,
};
