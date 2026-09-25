import { oc } from "@orpc/contract";
import * as z from "zod";

export const CatalogueLensSchema = z
  .enum(["capture", "dismissed", "ear", "failed", "quarantine", "unmatched"])
  .meta({ id: "CatalogueLens" });

export const CapturePriorityReasonSchema = z
  .object({
    kind: z.enum(["artist", "label", "none", "seed-label", "skipped-label", "unauthorized"]),
    name: z.string().nullable(),
  })
  .meta({ id: "CapturePriorityReason" });

export const CatalogueMatchSchema = z
  .object({
    artists: z.array(z.string()),
    logId: z.string().nullable(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "CatalogueMatch" });

export const CatalogueTrackItemSchema = z
  .object({
    albumImageUrl: z.string().nullable(),

    appleMusicUrl: z.string().nullable(),
    artists: z.array(z.string()),
    bpm: z.number().nullable(),
    capturePriority: z.number().nullable(),
    captureReason: CapturePriorityReasonSchema.nullable(),

    captureStatus: z.string().nullable(),

    captureVerification: z.string().nullable(),

    dismissedAt: z.string().nullable(),

    duplicateOf: CatalogueMatchSchema.nullable(),

    hasCapturedAudio: z.boolean(),

    hasPreview: z.boolean(),
    isrc: z.string().nullable(),
    key: z.string().nullable(),
    label: z.string().nullable(),
    nearestFinding: CatalogueMatchSchema.nullable(),
    nearestFindingScore: z.number().nullable(),
    rankedAt: z.string().nullable(),
    releaseDate: z.string().nullable(),

    sourceAudioAttemptedAt: z.string().nullable().optional(),
    spotifyUrl: z.string().nullable(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "CatalogueTrackItem" });

export const CatalogueSummarySchema = z
  .object({
    awaitingCapture: z.number(),
    awaitingRank: z.number(),

    dismissed: z.number(),

    quarantined: z.number(),
    ranked: z.number(),
    total: z.number(),
  })
  .meta({ id: "CatalogueSummary" });

export const listCatalogueTracks = oc
  .route({
    method: "GET",
    operationId: "listCatalogueTracks",
    path: "/admin/catalogue",
    summary: "The ranked catalogue: closest to a finding (`ear`), or next to capture (`capture`)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      lens: CatalogueLensSchema.default("ear"),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  )
  .output(
    z.object({
      ok: z.literal(true),
      summary: CatalogueSummarySchema,
      tracks: z.array(CatalogueTrackItemSchema),
    }),
  );

export const rankCatalogue = oc
  .route({
    method: "POST",
    operationId: "rankCatalogue",
    path: "/admin/catalogue/rank",
    summary: "One tick of the catalogue ranking sweep (nearest finding + capture priority)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      countRemaining: z.coerce.boolean().default(false),
      limit: z.coerce.number().int().min(1).max(1000).default(250),
    }),
  )
  .output(
    z.object({
      ok: z.literal(true),
      summary: z.object({
        catalogueDuplicates: z.number(),
        corpus: z.string(),
        embeddedFindings: z.number(),
        findings: z.number(),
        prioritized: z.number(),

        quarantined: z.number(),
        remaining: z.number(),
        scored: z.number(),
      }),

      telescope: z
        .union([
          z.object({ changed: z.boolean(), ok: z.literal(true), size: z.number() }),
          z.object({ ok: z.literal(false), reason: z.string() }),
        ])
        .optional(),
    }),
  );

export const recordDemand = oc
  .route({
    method: "POST",
    operationId: "recordDemand",
    path: "/admin/catalogue/demand",
    summary: "One demand tick: reorder crawl/capture priority from Simple Analytics pageviews",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(
    z.object({
      ok: z.literal(true),
      summary: z.object({
        configured: z.boolean(),

        demandedArtists: z.number(),

        demandedLabels: z.number(),

        frontierPromoted: z.number(),

        pagesRead: z.number(),

        totalPageviews: z.number(),

        tracksScored: z.number(),

        unknownSlugs: z.number(),

        window: z.object({ end: z.string(), start: z.string() }),
      }),
    }),
  );

export const clearWrongAudio = oc
  .route({
    method: "POST",
    operationId: "clearWrongAudio",
    path: "/admin/catalogue/wrong-audio/clear",
    summary: "Overrule the wrong-audio quarantine on one catalogue row (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ trackId: z.string().min(1) }))
  .output(z.object({ cleared: z.boolean(), ok: z.literal(true) }));

export const requeueUnmatchedCaptures = oc
  .route({
    method: "POST",
    operationId: "requeueUnmatchedCaptures",
    path: "/admin/catalogue/captures/requeue-unmatched",
    summary:
      "Re-queue terminal-unmatched catalogue captures after a matcher improvement (operator)",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(z.object({ ok: z.literal(true), requeued: z.number(), skippedVetoed: z.number() }));

export const requeueAnchor = oc
  .route({
    method: "POST",
    operationId: "requeueAnchor",
    path: "/admin/catalogue/anchor/requeue",
    summary: "Clear named rows' anchor re-ask backoff or terminal validation error (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ trackIds: z.array(z.string().min(1)).min(1).max(250) }))
  .output(z.object({ ok: z.literal(true), requeued: z.number() }));

export const requeueIsrcRecovery = oc
  .route({
    method: "POST",
    operationId: "requeueIsrcRecovery",
    path: "/admin/catalogue/isrc-recovery/requeue",
    summary: "Clear Deezer-empty ISRC-recovery stamps from a named window (operator)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      dryRun: z.boolean().default(true),
      since: z
        .string()
        .regex(
          /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z)?$/,
          "since must be an ISO date (2026-09-09) or instant (2026-09-09T00:00:00.000Z)",
        ),
    }),
  )
  .output(
    z.object({
      dryRun: z.boolean(),
      matched: z.number(),
      ok: z.literal(true),
      requeued: z.number(),
    }),
  );

export const flagWrongAudio = oc
  .route({
    method: "POST",
    operationId: "flagWrongAudio",
    path: "/admin/catalogue/wrong-audio/flag",
    summary: "Flag a finding's captured audio as the wrong recording (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ trackId: z.string().min(1) }))
  .output(z.object({ flagged: z.boolean(), ok: z.literal(true) }));

export const forceCapture = oc
  .route({
    method: "POST",
    operationId: "forceCapture",
    path: "/admin/catalogue/force-capture",
    summary: "Overrule the duplicate veto on one catalogue row so it can be captured (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ trackId: z.string().min(1) }))
  .output(z.object({ forced: z.boolean(), ok: z.literal(true) }));

export const certifyTrack = oc
  .route({
    method: "POST",
    operationId: "certifyTrack",
    path: "/admin/catalogue/certify",
    summary: "Certify an existing catalogue track in place — mint its finding (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ note: z.string().optional(), trackId: z.string().min(1) }))
  .output(z.object({ logId: z.string(), ok: z.literal(true) }));

export const setTrackDismissed = oc
  .route({
    method: "PUT",
    operationId: "setTrackDismissed",
    path: "/admin/catalogue/dismissed",
    summary: "Dismiss a catalogue track ('not for me') or restore it (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ dismissed: z.boolean(), trackId: z.string().min(1) }))
  .output(z.object({ changed: z.boolean(), ok: z.literal(true) }));

export const CaptureVerifyItemSchema = z
  .object({
    artists: z.array(z.string()),
    certified: z.boolean(),
    durationMs: z.number(),
    isrc: z.string().nullable(),
    logId: z.string().nullable(),
    sourceAudioKey: z.string(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "CaptureVerifyItem" });

export const listUnverifiedCaptures = oc
  .route({
    method: "GET",
    operationId: "listUnverifiedCaptures",
    path: "/admin/catalogue/captures/unverified",
    summary:
      "Captured rows not yet fingerprint-verified against their preview (the backfill worklist)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      count: z.coerce.boolean().default(false),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  )
  .output(
    z.object({
      ok: z.literal(true),

      queued: z.number().optional(),
      tracks: z.array(CaptureVerifyItemSchema),
    }),
  );

export const verifyCapture = oc
  .route({
    method: "POST",
    operationId: "verifyCapture",
    path: "/admin/catalogue/captures/verify",
    summary: "Record a capture's fingerprint verdict against its preview, and route it",
    tags: ["Admin"],
  })
  .input(
    z.object({
      trackId: z.string().min(1),
      verdict: z.enum(["match", "mismatch", "no-preview"]),
    }),
  )
  .output(
    z.object({
      action: z.enum([
        "flagged-finding",
        "not-captured",

        "operator-verified",
        "preview-match",
        "quarantined-catalogue",
        "unverified",
      ]),
      ok: z.literal(true),
    }),
  );

export const CrawlPassSchema = z
  .object({
    artistsRearmed: z.number().optional(),
    dryRun: z.boolean(),

    expanded: z.number(),

    failed: z.number(),

    frontierPending: z.number(),

    labelsDiscovered: z.array(z.string()),

    maxHop: z.number(),

    nodesEnqueued: z.number(),

    rateLimited: z.boolean(),

    releaseDetailsStored: z.number().optional(),

    releasesRearmed: z.number(),

    seeded: z.number(),

    seedsRearmed: z.number(),

    tracksAllowedIn: z.number().optional(),

    tracksFound: z.number(),

    tracksSkipped: z.number(),

    tracksSkippedArtistRule: z.number().optional(),

    tracksSkippedHeld: z.number().optional(),

    tracksSkippedLabelGate: z.number().optional(),

    tracksWritten: z.number(),
  })
  .meta({ id: "CrawlPass" });

const CrawlPhaseInitializationSchema = z.object({
  artistsRearmed: z.number(),
  releasesRearmed: z.number(),
  seeded: z.number(),
  seedsRearmed: z.number(),
});

export const MAX_CRAWL_PREPARE_LIMIT = 6;

const CrawlFetchPlanSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("single"), url: z.string().max(2_048) }),
  z.object({
    countField: z.literal("release-count"),
    kind: z.literal("tail"),
    pageSize: z.number().int().positive(),
    pageUrlTemplate: z.string().max(2_048),
    probeUrl: z.string().max(2_048),
  }),
]);

const SuppliedCrawlBodySchema = z.object({
  body: z.json().optional(),
  outcome: z.enum(["body", "empty", "invalid", "oversize", "throttled"]),
  url: z.string().max(2_048),
});

export const MAX_CRAWL_COMMIT_BATCH = MAX_CRAWL_PREPARE_LIMIT;

export const CRAWL_COMMIT_TOKEN_MAX_BYTES = 2 * 1024 * 1024;

export const CRAWL_COMMIT_BATCH_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

const CrawlCommitItemSchema = z.strictObject({
  commitToken: z.string().max(CRAWL_COMMIT_TOKEN_MAX_BYTES),
  operationId: z.literal("catalogue.crawl"),
  operationKey: z.string().max(128),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

const CrawlCommitReceiptSchema = z
  .object({
    elapsedMs: z.number().int().min(0).optional(),

    error: z.string().max(500).optional(),
    operationKey: z.string().max(128),
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
    result: z.json().optional(),
    resultIdentity: z.string().optional(),
    state: z.enum(["accepted", "committed", "rejected"]).optional(),
  })
  .meta({ id: "CrawlCommitReceipt" });

const CrawlPhaseCapabilitiesSchema = z.strictObject({
  commitBatchLimit: z.number().int().min(1).max(MAX_CRAWL_COMMIT_BATCH),

  commitBatchMaxTotalBytes: z.number().int().min(1),
});

const CrawlPhaseInputSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("initialize") }),
  z.object({
    limit: z.number().int().min(1).max(MAX_CRAWL_PREPARE_LIMIT).default(2),
    maxHop: z.number().int().min(0).max(3).default(2),
    phase: z.literal("prepare"),
    sampleStorableRepair: z.boolean().optional(),
  }),
  z.object({
    phase: z.literal("fetch"),
    preparedToken: z.string().max(2 * 1024 * 1024),

    supplied: z.array(SuppliedCrawlBodySchema).max(2).optional(),
  }),
  z.object({
    commitToken: z.string().max(2 * 1024 * 1024),
    operationId: z.literal("catalogue.crawl"),
    operationKey: z.string().max(128),
    phase: z.literal("commit"),
    requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
]);

const CrawlPhaseOutputSchema = z.discriminatedUnion("phase", [
  z.object({
    initialization: CrawlPhaseInitializationSchema,
    kind: z.enum(["initialized", "unavailable"]),
    ok: z.literal(true),
    phase: z.literal("initialize"),
  }),
  z.object({
    boxFetch: z.boolean(),
    capabilities: CrawlPhaseCapabilitiesSchema.optional(),
    frontierPending: z.number(),
    initialization: CrawlPhaseInitializationSchema,
    items: z
      .array(
        z.object({
          fetchPlan: CrawlFetchPlanSchema,
          nodeId: z.string(),
          nodeKind: z.enum(["artist", "label", "release"]).optional(),
          preparedToken: z.string(),
        }),
      )
      .max(MAX_CRAWL_PREPARE_LIMIT),
    kind: z.enum(["drained", "prepared", "unavailable"]),
    ok: z.literal(true),
    phase: z.literal("prepare"),
    storableReady: z.boolean().nullable().optional(),
  }),
  z.object({
    commitToken: z.string(),
    ok: z.literal(true),
    operationId: z.literal("catalogue.crawl"),
    operationKey: z.string(),
    phase: z.literal("fetch"),

    rateLimited: z.boolean().optional(),
    requestDigest: z.string(),
  }),
  z.object({
    ok: z.literal(true),
    phase: z.literal("commit"),
    receipt: z.object({
      outcome: z.enum([
        "committed",
        "conflict",
        "in-progress",
        "lookup-failed",
        "rejected",
        "safely-retryable",
      ]),
      replayed: z.boolean(),
      result: z.json().optional(),
      resultIdentity: z.string().optional(),
      state: z.enum(["accepted", "committed", "rejected"]).optional(),
    }),
  }),
]);

export const CrawlStatusSchema = z
  .object({
    anchorsPending: z.number(),

    catalogueTracks: z.number(),
    frontier: z.object({
      done: z.number(),
      failed: z.number(),
      pending: z.number(),
      skipped: z.number(),
    }),
    frontierByKind: z.object({
      artist: z.number(),
      label: z.number(),
      release: z.number(),
    }),

    labelsUndecided: z.number(),

    seedLabels: z.array(z.string()),

    storablePending: z.number(),

    undecidedLabelsQueued: z.number(),

    unstorablePending: z.number(),
  })
  .meta({ id: "CrawlStatus" });

export const CrawlPipelineSummarySchema = z
  .object({
    anchorsPending: z.number(),
    frontier: z.object({ pending: z.number() }),
    storablePending: z.number(),
    summary: z.literal(true),
    unstorablePending: z.number(),
  })
  .meta({ id: "CrawlPipelineSummary" });

export const crawlCatalogue = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "crawlCatalogue",
    path: "/admin/catalogue/crawl",
    summary: "Run one bounded, resumable pass of the catalogue crawler",
    tags: ["Admin"],
  })
  .input(
    z.object({
      body: CrawlPhaseInputSchema.optional(),
      query: z.object({
        dryRun: z.string().optional(),

        limit: z.string().optional(),

        maxHop: z.string().optional(),
      }),
    }),
  )
  .output(z.union([CrawlPassSchema.extend({ ok: z.literal(true) }), CrawlPhaseOutputSchema]));

export const commitCrawlNodes = oc
  .route({
    method: "POST",
    operationId: "commitCrawlNodes",
    path: "/admin/catalogue/crawl/commits",
    summary: "Commit one claim's fetched crawl nodes in a single admitted phase",
    tags: ["Admin"],
  })
  .input(
    z.strictObject({
      items: z.array(CrawlCommitItemSchema).min(1).max(MAX_CRAWL_COMMIT_BATCH),
    }),
  )
  .output(
    z.strictObject({
      deferred: z.number().int().min(0),
      ok: z.literal(true),

      receipts: z.array(CrawlCommitReceiptSchema).max(MAX_CRAWL_COMMIT_BATCH),
    }),
  );

export const getCrawlStatus = oc
  .route({
    method: "GET",
    operationId: "getCrawlStatus",
    path: "/admin/catalogue/crawl",
    summary: "The crawl frontier's state, the catalogue size, and the seed set",
    tags: ["Admin"],
  })
  .input(z.object({ summary: z.string().optional() }))
  .output(
    z.union([
      CrawlStatusSchema.extend({ ok: z.literal(true) }),
      CrawlPipelineSummarySchema.extend({ ok: z.literal(true) }),
    ]),
  );

export const ANCHOR_CANDIDATE_LIMIT = 100;

const ANCHOR_ARTIST_LIMIT = 20;

const ANCHOR_TEXT_MAX = 300;

const ANCHOR_ISRC_MAX = 64;

const ANCHOR_ID_MAX = 64;

const ANCHOR_URL_MAX = 2_048;

export const AnchorCandidateSchema = z
  .object({
    albumImageUrl: z.string().max(ANCHOR_URL_MAX).nullish(),

    artists: z
      .array(
        z.object({
          id: z.string().max(ANCHOR_ID_MAX).nullish(),
          name: z.string().max(ANCHOR_TEXT_MAX),
        }),
      )
      .max(ANCHOR_ARTIST_LIMIT)
      .default([]),
    durationMs: z.number().nullish(),
    isrc: z.string().max(ANCHOR_ISRC_MAX).nullish(),

    spotifyTrackId: z.string().max(ANCHOR_ID_MAX).optional(),
    title: z.string().max(ANCHOR_TEXT_MAX).default(""),

    uri: z.string().max(ANCHOR_URL_MAX).optional(),

    url: z.string().max(ANCHOR_URL_MAX).optional(),
  })

  .refine((candidate) => Boolean(candidate.spotifyTrackId ?? candidate.uri ?? candidate.url), {
    error: "a candidate must carry a spotifyTrackId, uri, or url",
  })
  .meta({ id: "AnchorCandidate" });

export const anchorTrack = oc
  .route({
    method: "POST",
    operationId: "anchorTrack",
    path: "/admin/catalogue/anchor",
    summary: "Verify box-supplied Spotify candidates against a catalogue row and write its anchor",
    tags: ["Admin"],
  })
  .input(
    z.object({
      candidates: z.array(AnchorCandidateSchema).max(ANCHOR_CANDIDATE_LIMIT).default([]),
      trackId: z.string().min(1),
    }),
  )
  .output(
    z.object({
      anchored: z.boolean(),
      ok: z.literal(true),

      verifiedBy: z.enum(["isrc", "search", "search-subset"]).nullable(),
    }),
  );

export const recordAnchorFailure = oc
  .route({
    method: "POST",
    operationId: "recordAnchorFailure",
    path: "/admin/catalogue/anchor/failure",
    summary: "Record a deterministic anchor candidate rejection",
    tags: ["Admin"],
  })
  .input(
    z.object({ status: z.union([z.literal(400), z.literal(422)]), trackId: z.string().min(1) }),
  )
  .output(z.object({ attempts: z.number().int(), ok: z.literal(true), terminal: z.boolean() }));

export const DEEZER_CANDIDATE_LIMIT = 5;

const DEEZER_TEXT_MAX = 300;

const DEEZER_ISRC_MAX = 64;

const DEEZER_TRACK_ID_MAX = 32;

export const DeezerIsrcCandidateSchema = z
  .object({
    artistName: z.string().max(DEEZER_TEXT_MAX),

    deezerTrackId: z.string().max(DEEZER_TRACK_ID_MAX).optional(),

    durationMs: z.number().positive().finite(),

    isrc: z.string().max(DEEZER_ISRC_MAX),
    title: z.string().max(DEEZER_TEXT_MAX),
  })
  .meta({ id: "DeezerIsrcCandidate" });

export const resolveAnchor = oc
  .route({
    method: "POST",
    operationId: "resolveAnchor",
    path: "/admin/catalogue/anchor/resolve",
    summary:
      "Resolve a catalogue row's Spotify anchor from the free rungs (ListenBrainz + dark Spotify search)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      deezerCandidates: z.array(DeezerIsrcCandidateSchema).max(DEEZER_CANDIDATE_LIMIT).optional(),

      spotifySearch: z.boolean().optional(),
      trackId: z.string().min(1),
    }),
  )
  .output(
    z.object({
      anchored: z.boolean(),

      apifyBudgetRemaining: z.number().int().nonnegative(),

      apifyEligible: z.boolean(),

      apifyEnabled: z.boolean(),

      apifyIneligibleReason: z.enum(["apify_budget_spent", "awaiting_free_ask"]).nullable(),

      freeDurationMsOmitted: z.number().int().nonnegative(),

      isrcRecoveredByDeezer: z.boolean(),

      listenbrainzOutcome: z.enum([
        "anchored",
        "empty-ids",
        "gate-rejected",
        "metadata-failed",
        "no-map",
        "no-mbid",
        "not-attempted",
        "request-failed",
        "yielded-on-breaker",
      ]),
      ok: z.literal(true),

      source: z.enum(["listenbrainz", "spotify-isrc", "spotify-search"]).nullable(),

      spotifyIsrcAsked: z.boolean(),

      spotifySearchDone: z.boolean(),

      spotifySearchEnabled: z.boolean(),

      spotifyThrottled: z.boolean(),

      stamped: z.boolean(),

      verifiedBy: z.enum(["isrc", "search", "search-subset"]).nullable(),
    }),
  );

export const resolveAnchorReview = oc
  .route({
    method: "POST",
    operationId: "resolveAnchorReview",
    path: "/admin/catalogue/anchor/reviews/{trackId}/resolve",
    summary: "Rule on a suspected version mismatch: anchor to the candidate, or dismiss (operator)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      resolution: z.enum(["accepted", "dismissed"]),
      trackId: z.string().min(1),
    }),
  )
  .output(
    z.object({
      anchored: z.boolean(),
      ok: z.literal(true),

      review: z.object({
        candidateTitle: z.string(),

        spotifyTrackId: z.string().optional(),
      }),
    }),
  );

export const setAnchorSearch = oc
  .route({
    method: "PUT",
    operationId: "setAnchorSearch",
    path: "/admin/catalogue/anchor/search",
    summary: "Flip the dark flag for the Spotify anchor-search rungs (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ enabled: z.boolean() }))
  .output(z.object({ enabled: z.boolean(), ok: z.literal(true) }));

export const setAnchorApify = oc
  .route({
    method: "PUT",
    operationId: "setAnchorApify",
    path: "/admin/catalogue/anchor/apify",
    summary: "Flip the Apify anchor-fallback kill-flag — off = no-budget graceful state (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ enabled: z.boolean() }))
  .output(z.object({ enabled: z.boolean(), ok: z.literal(true), requeued: z.number() }));

export const CaptureBudgetStateSchema = z
  .object({
    budget: z.object({ dailyBytes: z.number(), dailyTracks: z.number() }),

    closedReason: z.enum(["bytes_spent", "paused", "tracks_spent"]).nullable(),

    open: z.boolean(),
    paused: z.boolean(),
    remainingBytes: z.number(),
    remainingTracks: z.number(),
    spend: z.object({ bytes: z.number(), tracks: z.number() }),
    windowHours: z.number(),
  })
  .meta({ id: "CaptureBudgetState" });

export const getCaptureBudget = oc
  .route({
    method: "GET",
    operationId: "getCaptureBudget",
    path: "/admin/catalogue/capture-budget",
    summary: "The catalogue capture budget: the switch, the caps, the 24h spend, what is left",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(CaptureBudgetStateSchema.extend({ ok: z.literal(true) }));

export const setCaptureBudget = oc
  .route({
    method: "PUT",
    operationId: "setCaptureBudget",
    path: "/admin/catalogue/capture-budget",
    summary: "Set the catalogue capture budget / flip its kill switch (operator)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      dailyBytes: z.number().int().min(0).optional(),
      dailyTracks: z.number().int().min(0).optional(),
      paused: z.boolean().optional(),
    }),
  )
  .output(CaptureBudgetStateSchema.extend({ ok: z.literal(true) }));

export const AnchorApifyBudgetSchema = z
  .object({
    dailyRows: z.number(),

    day: z.string(),

    remainingRows: z.number(),

    rowsSent: z.number(),

    spent: z.boolean(),
  })
  .meta({ id: "AnchorApifyBudget" });

export const getAnchorApifyBudget = oc
  .route({
    method: "GET",
    operationId: "getAnchorApifyBudget",
    path: "/admin/catalogue/anchor/apify-budget",
    summary: "The metered Apify anchor rung's daily row cap, today's spend, and what is left",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(AnchorApifyBudgetSchema.extend({ ok: z.literal(true) }));

export const setAnchorApifyBudget = oc
  .route({
    method: "PUT",
    operationId: "setAnchorApifyBudget",
    path: "/admin/catalogue/anchor/apify-budget",
    summary: "Set the metered Apify anchor rung's daily row cap (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ dailyRows: z.number().int().min(0) }))
  .output(AnchorApifyBudgetSchema.extend({ ok: z.literal(true) }));

export const SpotifyAnchorBreakerStateSchema = z
  .object({
    cooldownRemainingMs: z.number(),

    reason: z.string().nullable(),

    throttlesInWindow: z.number(),

    tripped: z.boolean(),

    trippedAt: z.string().nullable(),
  })
  .meta({ id: "SpotifyAnchorBreakerState" });

export const AnchorRungFlagsSchema = z
  .object({
    apifyBudget: AnchorApifyBudgetSchema,

    apifyEnabled: z.boolean(),

    gateReason: z.enum([
      "friday_window",
      "flag_off",
      "breaker_quota",
      "breaker_throttle",
      "shared_meter",
      "open",
    ]),

    nextEligibleAt: z.string().nullable(),

    spotifySearchEnabled: z.boolean(),
  })
  .meta({ id: "AnchorRungFlags" });

export const getSpotifyAnchorBreaker = oc
  .route({
    method: "GET",
    operationId: "getSpotifyAnchorBreaker",
    path: "/admin/catalogue/anchor/breaker",
    summary:
      "The Spotify anchor-search throttle breaker: tripped, why, how long left, and the rungs",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(
    SpotifyAnchorBreakerStateSchema.extend({ ok: z.literal(true), rungs: AnchorRungFlagsSchema }),
  );

export const resetSpotifyAnchorBreaker = oc
  .route({
    method: "POST",
    operationId: "resetSpotifyAnchorBreaker",
    path: "/admin/catalogue/anchor/breaker/reset",
    summary: "Clear the Spotify anchor-search throttle breaker (operator)",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(SpotifyAnchorBreakerStateSchema.extend({ ok: z.literal(true) }));

export const AppleBreakerStateSchema = z
  .object({
    consecutiveAuthFailures: z.number(),

    cooldownRemainingMs: z.number(),

    tripped: z.boolean(),

    trippedAt: z.string().nullable(),
  })
  .meta({ id: "AppleBreakerState" });

export const resetAppleBreaker = oc
  .route({
    method: "POST",
    operationId: "resetAppleBreaker",
    path: "/admin/catalogue/apple-breaker/reset",
    summary: "Clear the Apple failure-regime breaker (operator)",
    tags: ["Admin"],
  })
  .input(z.object({}))
  .output(AppleBreakerStateSchema.extend({ ok: z.literal(true) }));

export const adminCatalogueContract = {
  anchor_track: anchorTrack,
  certify_track: certifyTrack,
  clear_wrong_audio: clearWrongAudio,
  commit_crawl_nodes: commitCrawlNodes,
  crawl_catalogue: crawlCatalogue,
  flag_wrong_audio: flagWrongAudio,
  force_capture: forceCapture,
  get_anchor_apify_budget: getAnchorApifyBudget,
  get_capture_budget: getCaptureBudget,
  get_crawl_status: getCrawlStatus,
  get_spotify_anchor_breaker: getSpotifyAnchorBreaker,
  list_catalogue_tracks: listCatalogueTracks,
  list_unverified_captures: listUnverifiedCaptures,
  rank_catalogue: rankCatalogue,
  record_anchor_failure: recordAnchorFailure,
  record_demand: recordDemand,
  requeue_anchor: requeueAnchor,
  requeue_isrc_recovery: requeueIsrcRecovery,
  requeue_unmatched_captures: requeueUnmatchedCaptures,
  reset_apple_breaker: resetAppleBreaker,
  reset_spotify_anchor_breaker: resetSpotifyAnchorBreaker,
  resolve_anchor: resolveAnchor,
  resolve_anchor_review: resolveAnchorReview,
  set_anchor_apify: setAnchorApify,
  set_anchor_apify_budget: setAnchorApifyBudget,
  set_anchor_search: setAnchorSearch,
  set_capture_budget: setCaptureBudget,
  set_track_dismissed: setTrackDismissed,
  verify_capture: verifyCapture,
};
