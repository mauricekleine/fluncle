import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  TRACK_PAGE_INDEXABLE_COVER_COUNT_INDEX,
  TRACK_PAGE_INDEXABLE_LEGACY_COUNT_INDEX,
  trackPageIndexableCoverIndexWhere,
  trackPageIndexableWhere,
} from "./track-page-indexability";

const float32Vector = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "F32_BLOB(1024)",
});

export const tracks = sqliteTable(
  "tracks",
  {
    album: text("album"),

    albumId: text("album_id"),

    albumImageUrl: text("album_image_url"),

    analyzedAt: text("analyzed_at"),

    analyzedFrom: text("analyzed_from", { enum: ["preview", "full"] }),

    anchorReviewJson: text("anchor_review_json"),

    appleMusicUrl: text("apple_music_url"),

    artistCreditsBackfilledAt: text("artist_credits_backfilled_at"),

    artistEdgesBackfilledAt: text("artist_edges_backfilled_at"),

    artistsJson: text("artists_json").notNull(),

    backfillAppleMusicAttemptedAt: text("backfill_apple_music_attempted_at"),

    backfillAppleMusicAttempts: integer("backfill_apple_music_attempts").notNull().default(0),

    backfillAppleMusicDoneAt: text("backfill_apple_music_done_at"),

    backfillAppleMusicFailures: integer("backfill_apple_music_failures").notNull().default(0),

    backfillBeatportAttemptedAt: text("backfill_beatport_attempted_at"),

    backfillBeatportAttempts: integer("backfill_beatport_attempts").notNull().default(0),

    backfillBeatportDoneAt: text("backfill_beatport_done_at"),

    backfillBeatportFailures: integer("backfill_beatport_failures").notNull().default(0),

    backfillDeezerAttemptedAt: text("backfill_deezer_attempted_at"),

    backfillDeezerAttempts: integer("backfill_deezer_attempts").notNull().default(0),

    backfillDeezerDoneAt: text("backfill_deezer_done_at"),

    backfillDeezerFailures: integer("backfill_deezer_failures").notNull().default(0),

    backfillDiscogsAttemptedAt: text("backfill_discogs_attempted_at"),

    backfillDiscogsAttempts: integer("backfill_discogs_attempts").notNull().default(0),

    backfillDiscogsDoneAt: text("backfill_discogs_done_at"),

    backfillDiscogsFailures: integer("backfill_discogs_failures").notNull().default(0),

    beatportUrl: text("beatport_url"),

    beatportVerifiedAt: text("beatport_verified_at"),

    bpm: real("bpm"),

    bpmConfidence: real("bpm_confidence"),

    bpmSource: text("bpm_source"),

    capturePriority: integer("capture_priority"),

    captureSourcePin: text("capture_source_pin"),

    captureSourcePinAllowDuration: integer("capture_source_pin_allow_duration", {
      mode: "boolean",
    })
      .notNull()
      .default(false),

    captureStatus: text("capture_status").notNull().default("pending"),

    captureVerification: text("capture_verification"),

    captureVerifiedAt: text("capture_verified_at"),

    catalogueRankCorpus: text("catalogue_rank_corpus"),

    catalogueRankedAt: text("catalogue_ranked_at"),

    deezerTrackId: text("deezer_track_id"),

    deezerVerifiedAt: text("deezer_verified_at"),

    deezerVerifiedBy: text("deezer_verified_by"),

    demandScore: integer("demand_score"),

    dismissedAt: text("dismissed_at"),

    duplicateOfTrackId: text("duplicate_of_track_id"),

    durationMs: integer("duration_ms").notNull(),

    embeddingBlob: float32Vector("embedding_blob"),

    featuresJson: text("features_json"),

    hasEmbedding: integer("has_embedding", { mode: "boolean" }).notNull().default(false),

    hasIsrc: integer("has_isrc", { mode: "boolean" }).notNull().default(false),

    inMasterId: integer("in_master_id"),

    inReleaseId: integer("in_release_id"),

    isCatalogue: integer("is_catalogue", { mode: "boolean" }).notNull().default(true),

    isrc: text("isrc"),

    isrcAttemptedAt: text("isrc_attempted_at"),

    isrcRecoveryAttemptedAt: text("isrc_recovery_attempted_at"),

    key: text("key"),

    keyConfidence: real("key_confidence"),

    keySource: text("key_source"),

    label: text("label"),

    labelId: text("label_id"),

    mbRecordingId: text("mb_recording_id"),

    mbRecordingIdAttemptedAt: text("mb_recording_id_attempted_at"),

    nearestFindingScore: real("nearest_finding_score"),

    nearestFindingTrackId: text("nearest_finding_track_id"),

    popularity: integer("popularity"),

    previewArchiveKey: text("preview_archive_key"),

    previewArchiveMime: text("preview_archive_mime"),

    previewArchiveSource: text("preview_archive_source"),

    previewArchivedAt: text("preview_archived_at"),

    previewUrl: text("preview_url"),

    releaseDate: text("release_date"),

    sourceAudioAttemptedAt: text("source_audio_attempted_at"),

    sourceAudioBytes: integer("source_audio_bytes"),

    sourceAudioCapturedAt: text("source_audio_captured_at"),

    sourceAudioFailures: integer("source_audio_failures").notNull().default(0),

    sourceAudioKey: text("source_audio_key"),

    sourceAudioRejected: text("source_audio_rejected"),

    sourceVerification: text("source_verification"),

    spotifyAnchorAttemptedAt: text("spotify_anchor_attempted_at"),

    spotifyAnchorAttempts: integer("spotify_anchor_attempts"),

    spotifyAnchorInvalidAttempts: integer("spotify_anchor_invalid_attempts").notNull().default(0),

    spotifyAnchorQuotaAdmittedAt: text("spotify_anchor_quota_admitted_at"),

    spotifyAnchorSource: text("spotify_anchor_source"),

    spotifyAnchorTerminalError: text("spotify_anchor_terminal_error"),

    spotifyAnchorVerifiedBy: text("spotify_anchor_verified_by"),

    spotifyAnchoredAt: text("spotify_anchored_at"),

    spotifyIsrcAskedAt: text("spotify_isrc_asked_at"),

    spotifyUri: text("spotify_uri"),

    spotifyUrl: text("spotify_url"),

    title: text("title").notNull(),

    trackId: text("track_id").primaryKey(),

    youtubeProvenanceFailures: integer("youtube_provenance_failures"),

    youtubeVerifiedAt: text("youtube_verified_at"),

    youtubeVerifiedBy: text("youtube_verified_by"),

    youtubeVideoId: text("youtube_video_id"),

    youtubeVideoOfficial: integer("youtube_video_official"),
  },

  (table) => [
    index("tracks_album_id_idx").on(table.albumId),
    index("tracks_label_id_idx").on(table.labelId),

    index("tracks_label_cover_idx").on(
      table.labelId,
      table.releaseDate,
      table.trackId,
      table.albumImageUrl,
    ),

    index("tracks_is_catalogue_idx")
      .on(table.isCatalogue)
      .where(sql`${table.isCatalogue} = 1`),

    index(TRACK_PAGE_INDEXABLE_LEGACY_COUNT_INDEX)
      .on(table.trackId)
      .where(sql.raw(trackPageIndexableWhere())),

    index(TRACK_PAGE_INDEXABLE_COVER_COUNT_INDEX)
      .on(
        table.duplicateOfTrackId,
        table.dismissedAt,
        table.spotifyUrl,
        table.appleMusicUrl,
        table.albumId,
        table.releaseDate,
        table.albumImageUrl,
        table.title,
        table.artistsJson,
      )
      .where(sql.raw(trackPageIndexableCoverIndexWhere())),

    index("tracks_fresh_catalogue_idx").on(table.isCatalogue, table.releaseDate, table.trackId),

    index("tracks_catalogue_active_track_id_idx").on(
      table.isCatalogue,
      table.dismissedAt,
      table.trackId,
    ),

    index("tracks_catalogue_ear_idx").on(
      table.isCatalogue,
      table.dismissedAt,
      table.nearestFindingScore,
      table.trackId,
    ),
    index("tracks_catalogue_capture_idx").on(
      table.isCatalogue,
      table.dismissedAt,
      table.capturePriority,
      table.trackId,
    ),

    index("tracks_vendor_worklist_idx").on(table.isCatalogue, table.capturePriority, table.trackId),

    index("tracks_funnel_scan_idx").on(
      table.isCatalogue,
      table.hasEmbedding,
      table.spotifyUri,
      table.sourceAudioKey,
      table.analyzedFrom,
      table.dismissedAt,
      table.duplicateOfTrackId,
      table.nearestFindingScore,
      table.durationMs,
      table.spotifyAnchorAttemptedAt,
      table.isrc,
      table.spotifyAnchorAttempts,
      table.artistsJson,
      table.labelId,
    ),

    index("tracks_release_date_idx").on(table.releaseDate),
    index("tracks_release_date_track_id_idx").on(table.releaseDate, table.trackId),

    index("tracks_bpm_idx").on(table.bpm),
    index("tracks_source_audio_attempted_at_idx").on(table.sourceAudioAttemptedAt),

    index("tracks_capture_verification_verified_at_idx").on(
      table.captureVerification,
      table.captureVerifiedAt,
    ),

    index("tracks_isrc_idx").on(table.isrc),

    index("tracks_anchor_queue_idx")
      .on(table.isrc)
      .where(sql`${table.spotifyUri} is null and ${table.isrc} is not null`),

    index("tracks_mb_recording_id_queue_idx")
      .on(table.trackId)
      .where(sql`${table.mbRecordingId} is null and ${table.mbRecordingIdAttemptedAt} is null`),

    index("tracks_mb_recording_id_idx").on(table.mbRecordingId),

    index("tracks_discogs_release_idx")
      .on(table.inReleaseId)
      .where(sql`${table.inReleaseId} is not null`),

    index("tracks_spotify_uri_idx").on(table.spotifyUri),
    index("tracks_deezer_track_id_idx").on(table.deezerTrackId),

    index("tracks_artist_edges_backfill_queue_idx")
      .on(table.trackId)
      .where(sql`${table.artistEdgesBackfilledAt} is null`),

    index("tracks_artist_credits_backfill_queue_idx")
      .on(table.trackId)
      .where(
        sql`${table.artistCreditsBackfilledAt} is null and ${table.artistEdgesBackfilledAt} is not null`,
      ),

    index("tracks_embed_queue_idx")
      .on(table.trackId)
      .where(sql`${table.sourceAudioKey} is not null and ${table.hasEmbedding} = 0`),

    index("tracks_anchor_order_idx")
      .on(table.hasIsrc, table.hasEmbedding, table.nearestFindingScore, table.trackId)
      .where(sql`${table.spotifyUri} is null`),

    index("tracks_anchor_prior_order_idx")
      .on(table.hasIsrc, table.hasEmbedding, table.nearestFindingScore, table.trackId)
      .where(sql`${table.spotifyUri} is null and ${table.spotifyIsrcAskedAt} is not null`),

    index("tracks_anchor_review_idx")
      .on(table.trackId)
      .where(sql`${table.anchorReviewJson} is not null`),

    index("tracks_anchor_terminal_idx")
      .on(table.trackId)
      .where(sql`${table.spotifyAnchorTerminalError} is not null`),

    index("tracks_dismissed_idx")
      .on(table.dismissedAt)
      .where(sql`${table.dismissedAt} is not null`),

    index("tracks_demand_score_idx")
      .on(table.demandScore)
      .where(sql`${table.demandScore} is not null`),

    index("tracks_key_idx").on(table.key),

    index("tracks_capture_priority_track_id_idx")
      .on(table.capturePriority, table.trackId)
      .where(sql`${table.capturePriority} is not null`),
  ],
);

export const trackEmbeddings = sqliteTable("track_embeddings", {
  embeddingBlob: float32Vector("embedding_blob").notNull(),
  trackId: text("track_id")
    .primaryKey()
    .references(() => tracks.trackId, { onDelete: "cascade" }),
});

export const trackDuplicateKeys = sqliteTable(
  "track_duplicate_keys",
  {
    matchKey: text("match_key").notNull(),
    normalizedIsrc: text("normalized_isrc"),
    trackId: text("track_id")
      .primaryKey()
      .references(() => tracks.trackId, { onDelete: "cascade" }),
  },
  (table) => [
    index("track_duplicate_keys_match_key_track_id_idx").on(table.matchKey, table.trackId),
    index("track_duplicate_keys_isrc_track_id_idx").on(table.normalizedIsrc, table.trackId),
  ],
);

export const dueWork = sqliteTable(
  "due_work",
  {
    claimExpiresAt: text("claim_expires_at"),
    claimToken: text("claim_token"),
    claimedBy: text("claimed_by"),
    generation: text("generation").notNull(),
    nextDueAt: text("next_due_at").notNull(),
    repairEnteredAt: text("repair_entered_at"),
    sortKey: text("sort_key").notNull(),
    sourceVersion: text("source_version").notNull(),
    state: text("state").notNull(),
    subjectId: text("subject_id").notNull(),
    subjectType: text("subject_type").notNull(),
    updatedAt: text("updated_at").notNull(),
    workKind: text("work_kind").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workKind, table.subjectType, table.subjectId] }),
    check(
      "due_work_state_check",
      sql`${table.state} in ('ready', 'scheduled', 'leased', 'repair')`,
    ),
    check(
      "due_work_subject_type_check",
      sql`${table.subjectType} in ('track', 'artist', 'album', 'label')`,
    ),

    index("due_work_ready_idx")
      .on(table.workKind, table.state, table.sortKey, table.subjectId)
      .where(sql`${table.state} = 'ready'`),
    index("due_work_scheduled_idx")
      .on(table.workKind, table.state, table.nextDueAt, table.subjectId)
      .where(sql`${table.state} = 'scheduled'`),
    index("due_work_repair_idx")
      .on(table.state, table.subjectType, table.subjectId)
      .where(sql`${table.state} = 'repair'`),
    index("due_work_lease_idx")
      .on(table.state, table.claimExpiresAt, table.workKind, table.subjectId)
      .where(sql`${table.state} = 'leased'`),
    index("due_work_claim_idx")
      .on(
        table.workKind,
        table.state,
        table.claimedBy,
        table.claimToken,
        table.sortKey,
        table.subjectId,
      )
      .where(sql`${table.state} = 'leased'`),
    index("due_work_cleanup_idx")
      .on(table.workKind, table.subjectType, table.generation, table.updatedAt, table.subjectId)
      .where(sql`${table.state} <> 'repair'`),
  ],
);

export const dueWorkRebuilds = sqliteTable(
  "due_work_rebuilds",
  {
    completedAt: text("completed_at"),
    cursor: text("cursor"),

    definitionVersion: text("definition_version"),
    generation: text("generation").notNull(),
    projectedCount: integer("projected_count").notNull().default(0),
    scannedCount: integer("scanned_count").notNull().default(0),
    startedAt: text("started_at").notNull(),
    state: text("state").notNull(),
    subjectType: text("subject_type").notNull(),
    updatedAt: text("updated_at").notNull(),
    workKind: text("work_kind").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workKind, table.subjectType] }),
    check("due_work_rebuilds_state_check", sql`${table.state} in ('running', 'complete')`),
    check(
      "due_work_rebuilds_subject_type_check",
      sql`${table.subjectType} in ('track', 'artist', 'album', 'label')`,
    ),
  ],
);

export const crawlDueWork = sqliteTable(
  "crawl_due_work",
  {
    claimExpiresAt: text("claim_expires_at"),
    claimPosition: integer("claim_position"),
    claimToken: text("claim_token"),
    claimedBy: text("claimed_by"),
    createdAt: text("created_at").notNull(),
    demandRank: integer("demand_rank").notNull(),
    generation: text("generation").notNull(),
    hop: integer("hop").notNull(),
    labelSlug: text("label_slug"),
    nextDueAt: text("next_due_at"),
    nodeId: text("node_id").primaryKey(),
    nodeKind: text("node_kind", { enum: ["artist", "label", "release"] }).notNull(),
    parentId: text("parent_id"),
    repairEnteredAt: text("repair_entered_at"),
    sourceVersion: text("source_version").notNull(),
    state: text("state", { enum: ["ready", "scheduled", "leased", "repair"] }).notNull(),

    storableRank: integer("storable_rank"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "crawl_due_work_node_kind_check",
      sql`${table.nodeKind} in ('artist', 'label', 'release')`,
    ),
    check(
      "crawl_due_work_state_check",
      sql`${table.state} in ('ready', 'scheduled', 'leased', 'repair')`,
    ),
    check("crawl_due_work_hop_check", sql`${table.hop} >= 0`),
    check("crawl_due_work_demand_rank_check", sql`${table.demandRank} in (0, 1)`),
    check(
      "crawl_due_work_storable_rank_check",
      sql`(${table.nodeKind} = 'release' and ${table.storableRank} in (0, 1)) or (${table.nodeKind} <> 'release' and ${table.storableRank} is null)`,
    ),
    check(
      "crawl_due_work_lifecycle_check",
      sql`(${table.state} = 'ready' and ${table.nextDueAt} is null and ${table.claimExpiresAt} is null and ${table.claimPosition} is null and ${table.claimToken} is null and ${table.claimedBy} is null)
        or (${table.state} = 'scheduled' and ${table.nextDueAt} is not null and ${table.claimExpiresAt} is null and ${table.claimPosition} is null and ${table.claimToken} is null and ${table.claimedBy} is null)
        or (${table.state} = 'leased' and ${table.nextDueAt} is null and ${table.claimExpiresAt} is not null and ${table.claimPosition} is not null and ${table.claimPosition} >= 0 and ${table.claimToken} is not null and ${table.claimedBy} is not null)
        or (${table.state} = 'repair' and ${table.nextDueAt} is null and ${table.claimExpiresAt} is null and ${table.claimPosition} is null and ${table.claimToken} is null and ${table.claimedBy} is null)`,
    ),
    index("crawl_due_work_release_ready_idx")
      .on(
        table.state,
        table.storableRank,
        table.hop,
        table.demandRank,
        table.createdAt,
        table.nodeId,
      )
      .where(sql`${table.state} = 'ready' and ${table.nodeKind} = 'release'`),
    index("crawl_due_work_ready_idx")
      .on(table.state, table.hop, table.demandRank, table.createdAt, table.nodeId)
      .where(sql`${table.state} = 'ready'`),
    index("crawl_due_work_scheduled_idx")
      .on(table.state, table.nextDueAt, table.nodeId)
      .where(sql`${table.state} = 'scheduled'`),
    index("crawl_due_work_repair_idx")
      .on(table.state, table.nodeId)
      .where(sql`${table.state} = 'repair'`),
    index("crawl_due_work_lease_idx")
      .on(table.state, table.claimExpiresAt, table.nodeId)
      .where(sql`${table.state} = 'leased'`),
    index("crawl_due_work_label_slug_node_id_idx").on(table.labelSlug, table.nodeId),
    index("crawl_due_work_parent_id_node_id_idx").on(table.parentId, table.nodeId),
    index("crawl_due_work_cleanup_idx")
      .on(table.generation, table.updatedAt, table.nodeId)
      .where(sql`${table.state} <> 'repair'`),
    uniqueIndex("crawl_due_work_claim_position_idx")
      .on(table.claimedBy, table.claimToken, table.claimPosition)
      .where(sql`${table.state} = 'leased'`),
  ],
);

export const crawlProjectionRepairs = sqliteTable(
  "crawl_projection_repairs",
  {
    createdAt: text("created_at").notNull(),
    sourceEpoch: integer("source_epoch").notNull(),
    sourceId: text("source_id").notNull(),
    sourceType: text("source_type", { enum: ["artist", "label"] }).notNull(),
    sourceVersion: text("source_version").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceType, table.sourceId] }),
    check(
      "crawl_projection_repairs_source_type_check",
      sql`${table.sourceType} in ('label', 'artist')`,
    ),
    check("crawl_projection_repairs_epoch_check", sql`${table.sourceEpoch} >= 0`),
    index("crawl_projection_repairs_order_idx").on(
      table.sourceEpoch,
      table.sourceType,
      table.sourceId,
    ),
  ],
);

export const crawlDueWorkRebuilds = sqliteTable(
  "crawl_due_work_rebuilds",
  {
    completedAt: text("completed_at"),
    cursor: text("cursor"),

    definitionVersion: text("definition_version"),
    generation: text("generation").notNull(),
    projectedCount: integer("projected_count").notNull(),
    projectedDigest: text("projected_digest"),
    scannedCount: integer("scanned_count").notNull(),
    scope: text("scope").primaryKey(),
    sourceDigest: text("source_digest"),
    startedAt: text("started_at").notNull(),
    state: text("state", { enum: ["running", "complete"] }).notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("crawl_due_work_rebuilds_scope_check", sql`${table.scope} = 'frontier'`),
    check(
      "crawl_due_work_rebuilds_count_check",
      sql`${table.projectedCount} >= 0 and ${table.scannedCount} >= 0`,
    ),
    check(
      "crawl_due_work_rebuilds_state_check",
      sql`(${table.state} = 'running' and ${table.completedAt} is null)
        or (${table.state} = 'complete' and ${table.completedAt} is not null and ${table.sourceDigest} is not null and ${table.projectedDigest} is not null)`,
    ),
  ],
);

export const artistQualification = sqliteTable(
  "artist_qualification",
  {
    artistId: text("artist_id").primaryKey(),
    certifiedFindingCount: integer("certified_finding_count").notNull(),
    enabledCreditHalfUnits: integer("enabled_credit_half_units").notNull(),
    generation: text("generation").notNull(),
    isQualified: integer("is_qualified", { mode: "boolean" }).notNull(),
    sourceVersion: text("source_version").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "artist_qualification_count_check",
      sql`${table.certifiedFindingCount} >= 0 and ${table.enabledCreditHalfUnits} >= 0`,
    ),
    check(
      "artist_qualification_exact_check",
      sql`(${table.isQualified} = 1 and (${table.certifiedFindingCount} > 0 or ${table.enabledCreditHalfUnits} >= 6))
        or (${table.isQualified} = 0 and ${table.certifiedFindingCount} = 0 and ${table.enabledCreditHalfUnits} < 6)`,
    ),
    index("artist_qualification_qualified_idx")
      .on(table.isQualified, table.artistId)
      .where(sql`${table.isQualified} = 1`),
  ],
);

export const artistQualificationContributions = sqliteTable(
  "artist_qualification_contributions",
  {
    artistId: text("artist_id").notNull(),
    certifiedContribution: integer("certified_contribution").notNull(),
    enabledCreditHalfUnits: integer("enabled_credit_half_units").notNull(),
    generation: text("generation").notNull(),
    sourceVersion: text("source_version").notNull(),
    trackId: text("track_id").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.trackId, table.artistId] }),
    check(
      "artist_qualification_contributions_certified_check",
      sql`${table.certifiedContribution} in (0, 1)`,
    ),
    check(
      "artist_qualification_contributions_credit_check",
      sql`${table.enabledCreditHalfUnits} in (0, 1, 2)`,
    ),
    index("artist_qualification_contributions_artist_track_idx").on(table.artistId, table.trackId),
  ],
);

export const artistQualificationState = sqliteTable(
  "artist_qualification_state",
  {
    auditedAt: text("audited_at"),
    completedAt: text("completed_at"),
    cursor: text("cursor"),
    generation: text("generation").notNull(),
    projectedDigest: text("projected_digest"),
    projectedQualifiedCount: integer("projected_qualified_count").notNull(),
    projectionEpoch: integer("projection_epoch").notNull(),
    rebuildStartEpoch: integer("rebuild_start_epoch").notNull(),
    scannedCount: integer("scanned_count").notNull(),
    scope: text("scope").primaryKey(),
    sourceDigest: text("source_digest"),
    sourceEpoch: integer("source_epoch").notNull(),
    sourceQualifiedCount: integer("source_qualified_count").notNull(),
    startedAt: text("started_at").notNull(),
    state: text("state", { enum: ["running", "complete"] }).notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("artist_qualification_state_scope_check", sql`${table.scope} = 'artists'`),
    check(
      "artist_qualification_state_epoch_check",
      sql`${table.sourceEpoch} >= 0 and ${table.projectionEpoch} >= 0 and ${table.projectionEpoch} <= ${table.sourceEpoch} and ${table.rebuildStartEpoch} >= 0 and ${table.rebuildStartEpoch} <= ${table.sourceEpoch}`,
    ),
    check(
      "artist_qualification_state_count_check",
      sql`${table.scannedCount} >= 0 and ${table.sourceQualifiedCount} >= 0 and ${table.projectedQualifiedCount} >= 0`,
    ),
    check(
      "artist_qualification_state_lifecycle_check",
      sql`(${table.state} = 'running' and ${table.completedAt} is null)
        or (${table.state} = 'complete' and ${table.completedAt} is not null and ${table.sourceDigest} is not null and ${table.projectedDigest} is not null)`,
    ),
  ],
);

export const publicAggregateCounts = sqliteTable(
  "public_aggregate_counts",
  {
    aggregateKind: text("aggregate_kind", {
      enum: ["key", "release_date_bucket"],
    }).notNull(),
    bucket: text("bucket").notNull(),
    generation: text("generation").notNull(),
    sourceVersion: text("source_version").notNull(),
    trackCount: integer("track_count").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.aggregateKind, table.bucket] }),
    check(
      "public_aggregate_counts_kind_check",
      sql`${table.aggregateKind} in ('key', 'release_date_bucket')`,
    ),
    check("public_aggregate_counts_count_check", sql`${table.trackCount} >= 0`),
    check(
      "public_aggregate_counts_bucket_check",
      sql`${table.aggregateKind} <> 'release_date_bucket' or length(${table.bucket}) <= 4`,
    ),
  ],
);

export const publicAggregateMembership = sqliteTable(
  "public_aggregate_membership",
  {
    generation: text("generation").notNull(),
    keyBucket: text("key_bucket"),
    releaseDateBucket: text("release_date_bucket"),
    sourceVersion: text("source_version").notNull(),
    trackId: text("track_id").primaryKey(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "public_aggregate_membership_release_date_bucket_check",
      sql`${table.releaseDateBucket} is null or length(${table.releaseDateBucket}) <= 4`,
    ),
  ],
);

export const publicAggregateState = sqliteTable(
  "public_aggregate_state",
  {
    aggregateEpoch: integer("aggregate_epoch").notNull(),
    auditedAt: text("audited_at"),
    completedAt: text("completed_at"),
    cursor: text("cursor"),
    defaultTrackTotal: integer("default_track_total").notNull(),
    generation: text("generation").notNull(),
    projectedDigest: text("projected_digest"),
    projectedEntryCount: integer("projected_entry_count").notNull(),
    rebuildStartEpoch: integer("rebuild_start_epoch").notNull(),
    releaseHubOrderEpoch: integer("release_hub_order_epoch").notNull(),
    scannedCount: integer("scanned_count").notNull(),
    scope: text("scope").primaryKey(),
    sourceDigest: text("source_digest"),
    sourceEntryCount: integer("source_entry_count").notNull(),
    sourceEpoch: integer("source_epoch").notNull(),
    startedAt: text("started_at").notNull(),
    state: text("state", { enum: ["running", "complete"] }).notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("public_aggregate_state_scope_check", sql`${table.scope} = 'tracks'`),
    check(
      "public_aggregate_state_epoch_check",
      sql`${table.sourceEpoch} >= 0 and ${table.aggregateEpoch} >= 0 and ${table.aggregateEpoch} <= ${table.sourceEpoch} and ${table.rebuildStartEpoch} >= 0 and ${table.rebuildStartEpoch} <= ${table.sourceEpoch} and ${table.releaseHubOrderEpoch} >= 0`,
    ),
    check(
      "public_aggregate_state_count_check",
      sql`${table.defaultTrackTotal} >= 0 and ${table.scannedCount} >= 0 and ${table.sourceEntryCount} >= 0 and ${table.projectedEntryCount} >= 0`,
    ),
    check(
      "public_aggregate_state_lifecycle_check",
      sql`(${table.state} = 'running' and ${table.completedAt} is null)
        or (${table.state} = 'complete' and ${table.completedAt} is not null and ${table.sourceDigest} is not null and ${table.projectedDigest} is not null)`,
    ),
  ],
);

export const projectionRepairs = sqliteTable(
  "projection_repairs",
  {
    createdAt: text("created_at").notNull(),
    projection: text("projection", {
      enum: ["artist_qualification", "public_aggregates"],
    }).notNull(),
    sourceEpoch: integer("source_epoch").notNull(),
    sourceVersion: text("source_version").notNull(),
    subjectId: text("subject_id").notNull(),
    subjectType: text("subject_type", { enum: ["artist", "label", "track"] }).notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projection, table.subjectType, table.subjectId] }),
    check(
      "projection_repairs_projection_check",
      sql`${table.projection} in ('artist_qualification', 'public_aggregates')`,
    ),
    check(
      "projection_repairs_subject_check",
      sql`(${table.projection} = 'artist_qualification' and ${table.subjectType} in ('artist', 'label', 'track'))
        or (${table.projection} = 'public_aggregates' and ${table.subjectType} = 'track')`,
    ),
    check("projection_repairs_epoch_check", sql`${table.sourceEpoch} >= 0`),
    index("projection_repairs_order_idx").on(
      table.projection,
      table.sourceEpoch,
      table.subjectType,
      table.subjectId,
    ),
  ],
);

export const operationReceipts = sqliteTable(
  "operation_receipts",
  {
    createdAt: text("created_at").notNull(),
    operationId: text("operation_id").notNull(),
    operationKey: text("operation_key").primaryKey(),
    requestDigest: text("request_digest").notNull(),
    resultIdentity: text("result_identity"),
    resultJson: text("result_json"),
    state: text("state", { enum: ["accepted", "committed", "rejected"] }).notNull(),
    terminalAt: text("terminal_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "operation_receipts_identity_bounds_check",
      sql`typeof(${table.operationKey}) = 'text' and length(cast(${table.operationKey} as blob)) between 1 and 256
        and typeof(${table.operationId}) = 'text' and length(cast(${table.operationId} as blob)) between 1 and 64
        and (${table.resultIdentity} is null or (typeof(${table.resultIdentity}) = 'text' and length(cast(${table.resultIdentity} as blob)) between 1 and 512))`,
    ),
    check(
      "operation_receipts_digest_check",
      sql`typeof(${table.requestDigest}) = 'text' and length(${table.requestDigest}) = 64 and length(cast(${table.requestDigest} as blob)) = 64 and ${table.requestDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      "operation_receipts_result_json_check",
      sql`${table.resultJson} is null or (typeof(${table.resultJson}) = 'text' and length(cast(${table.resultJson} as blob)) between 1 and 16384 and json_valid(${table.resultJson}))`,
    ),
    check(
      "operation_receipts_timestamp_check",
      sql`typeof(${table.createdAt}) = 'text' and length(cast(${table.createdAt} as blob)) between 1 and 64
        and typeof(${table.updatedAt}) = 'text' and length(cast(${table.updatedAt} as blob)) between 1 and 64
        and ${table.updatedAt} >= ${table.createdAt}
        and (${table.terminalAt} is null or (typeof(${table.terminalAt}) = 'text' and length(cast(${table.terminalAt} as blob)) between 1 and 64 and ${table.terminalAt} >= ${table.createdAt} and ${table.terminalAt} <= ${table.updatedAt}))`,
    ),
    check(
      "operation_receipts_state_check",
      sql`${table.state} in ('accepted', 'committed', 'rejected')`,
    ),
    check(
      "operation_receipts_lifecycle_check",
      sql`(${table.state} = 'accepted' and ${table.resultIdentity} is null and ${table.resultJson} is null and ${table.terminalAt} is null)
        or (${table.state} in ('committed', 'rejected') and ${table.resultIdentity} is not null and ${table.resultJson} is not null and ${table.terminalAt} is not null)`,
    ),
    index("operation_receipts_stale_accepted_idx")
      .on(table.state, table.updatedAt, table.operationKey)
      .where(sql`${table.state} = 'accepted'`),
  ],
);

export const databaseAdmissionLanes = sqliteTable(
  "database_admission_lanes",
  {
    lane: text("lane", { enum: ["heavy-read", "write"] }).primaryKey(),
    nextFencingToken: integer("next_fencing_token").notNull().default(0),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    check("database_admission_lanes_lane_check", sql`${table.lane} in ('heavy-read', 'write')`),
    check(
      "database_admission_lanes_token_check",
      sql`${table.nextFencingToken} >= 0 and ${table.updatedAtMs} >= 0`,
    ),
  ],
);

export const databaseAdmissionContenders = sqliteTable(
  "database_admission_contenders",
  {
    acquiredAtMs: integer("acquired_at_ms"),
    contenderId: text("contender_id").primaryKey(),
    enqueuedAtMs: integer("enqueued_at_ms").notNull(),
    fencingToken: integer("fencing_token"),
    lane: text("lane", { enum: ["heavy-read", "write"] }).notNull(),
    leaseExpiresAtMs: integer("lease_expires_at_ms"),
    operationId: text("operation_id").notNull(),
    ownerId: text("owner_id").notNull(),
    queueHeartbeatAtMs: integer("queue_heartbeat_at_ms").notNull(),
    runId: text("run_id").notNull(),
    state: text("state", { enum: ["active", "queued"] }).notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    check(
      "database_admission_contenders_lane_check",
      sql`${table.lane} in ('heavy-read', 'write')`,
    ),
    check("database_admission_contenders_state_check", sql`${table.state} in ('active', 'queued')`),
    check(
      "database_admission_contenders_identity_bounds_check",
      sql`typeof(${table.contenderId}) = 'text' and length(cast(${table.contenderId} as blob)) between 1 and 192
        and typeof(${table.operationId}) = 'text' and length(cast(${table.operationId} as blob)) between 1 and 64
        and typeof(${table.ownerId}) = 'text' and length(cast(${table.ownerId} as blob)) between 1 and 128
        and typeof(${table.runId}) = 'text' and length(cast(${table.runId} as blob)) between 1 and 128`,
    ),
    check(
      "database_admission_contenders_time_check",
      sql`${table.enqueuedAtMs} >= 0 and ${table.queueHeartbeatAtMs} >= ${table.enqueuedAtMs}
        and ${table.updatedAtMs} >= ${table.enqueuedAtMs}
        and (${table.acquiredAtMs} is null or ${table.acquiredAtMs} >= ${table.enqueuedAtMs})
        and (${table.leaseExpiresAtMs} is null or ${table.leaseExpiresAtMs} >= ${table.enqueuedAtMs})`,
    ),
    check(
      "database_admission_contenders_lifecycle_check",
      sql`(${table.state} = 'queued' and ${table.acquiredAtMs} is null and ${table.fencingToken} is null and ${table.leaseExpiresAtMs} is null)
        or (${table.state} = 'active' and ${table.acquiredAtMs} is not null and ${table.fencingToken} is not null and ${table.fencingToken} > 0 and ${table.leaseExpiresAtMs} is not null and ${table.leaseExpiresAtMs} > ${table.acquiredAtMs})`,
    ),
    uniqueIndex("database_admission_contenders_owner_run_idx").on(table.ownerId, table.runId),
    uniqueIndex("database_admission_contenders_active_lane_idx")
      .on(table.lane)
      .where(sql`${table.state} = 'active'`),
    index("database_admission_contenders_queue_idx")
      .on(table.lane, table.state, table.enqueuedAtMs, table.contenderId)
      .where(sql`${table.state} = 'queued'`),
    index("database_admission_contenders_queue_heartbeat_idx")
      .on(table.state, table.queueHeartbeatAtMs, table.contenderId)
      .where(sql`${table.state} = 'queued'`),
    index("database_admission_contenders_lease_idx")
      .on(table.state, table.leaseExpiresAtMs, table.lane, table.contenderId)
      .where(sql`${table.state} = 'active'`),
  ],
);

export const artifactChanges = sqliteTable(
  "artifact_changes",
  {
    createdAt: text("created_at").notNull(),
    formatVersion: integer("format_version").notNull(),
    operation: text("operation", { enum: ["upsert", "delete"] }).notNull(),
    payloadBlob: float32Vector("payload_blob"),
    payloadJson: text("payload_json").notNull(),
    producer: text("producer").notNull(),
    revision: integer("revision").notNull(),
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    stream: text("stream").notNull(),
    streamVersion: integer("stream_version").notNull(),
    subjectId: text("subject_id").notNull(),
    subjectType: text("subject_type").notNull(),
  },
  (table) => [
    check("artifact_changes_operation_check", sql`${table.operation} in ('upsert', 'delete')`),
    check(
      "artifact_changes_version_check",
      sql`${table.formatVersion} >= 1 and ${table.streamVersion} >= 1 and ${table.revision} >= 1`,
    ),
    check(
      "artifact_changes_tombstone_check",
      sql`${table.operation} <> 'delete' or ${table.payloadBlob} is null`,
    ),
    uniqueIndex("artifact_changes_revision_idx").on(
      table.stream,
      table.streamVersion,
      table.subjectType,
      table.subjectId,
      table.revision,
    ),
    index("artifact_changes_stream_seq_idx").on(table.stream, table.streamVersion, table.seq),
  ],
);

export const artifactChangeRevisions = sqliteTable(
  "artifact_change_revisions",
  {
    contentDigest: text("content_digest").notNull(),
    createdAt: text("created_at").notNull(),
    eventSeq: integer("event_seq").notNull(),
    producer: text("producer").notNull(),
    revision: integer("revision").notNull(),
    stream: text("stream").notNull(),
    streamVersion: integer("stream_version").notNull(),
    subjectId: text("subject_id").notNull(),
    subjectType: text("subject_type").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.stream,
        table.streamVersion,
        table.subjectType,
        table.subjectId,
        table.revision,
      ],
    }),
    check(
      "artifact_change_revisions_value_check",
      sql`${table.streamVersion} >= 1 and ${table.revision} >= 1 and ${table.eventSeq} >= 1`,
    ),
    uniqueIndex("artifact_change_revisions_event_seq_idx").on(table.eventSeq),
  ],
);

export const artifactChangeConsumers = sqliteTable(
  "artifact_change_consumers",
  {
    appliedThroughSeq: integer("applied_through_seq"),
    checkpointedAt: text("checkpointed_at"),
    consumerId: text("consumer_id").primaryKey(),
    registeredAt: text("registered_at").notNull(),
    snapshotSeq: integer("snapshot_seq"),
    state: text("state", { enum: ["rebuilding", "active", "inactive"] }).notNull(),
    stateChangedAt: text("state_changed_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "artifact_change_consumers_state_check",
      sql`${table.state} in ('rebuilding', 'active', 'inactive')`,
    ),
    check(
      "artifact_change_consumers_checkpoint_check",
      sql`(${table.state} = 'rebuilding' and ${table.snapshotSeq} is not null and ${table.snapshotSeq} >= 0 and ${table.appliedThroughSeq} is null and ${table.checkpointedAt} is null)
        or (${table.state} = 'active' and ${table.snapshotSeq} is not null and ${table.snapshotSeq} >= 0 and ${table.appliedThroughSeq} is not null and ${table.appliedThroughSeq} >= ${table.snapshotSeq} and ${table.checkpointedAt} is not null)
        or (${table.state} = 'inactive' and ${table.snapshotSeq} is null and ${table.appliedThroughSeq} is null and ${table.checkpointedAt} is null)`,
    ),
  ],
);

export const artifactChangeConsumerContracts = sqliteTable(
  "artifact_change_consumer_contracts",
  {
    consumerId: text("consumer_id")
      .notNull()
      .references(() => artifactChangeConsumers.consumerId, { onDelete: "cascade" }),
    declaredAt: text("declared_at").notNull(),
    formatVersion: integer("format_version").notNull(),
    stream: text("stream").notNull(),
    streamVersion: integer("stream_version").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.consumerId, table.stream, table.streamVersion, table.formatVersion],
    }),
    check(
      "artifact_change_consumer_contracts_version_check",
      sql`${table.streamVersion} >= 1 and ${table.formatVersion} >= 1`,
    ),
  ],
);

export const artifactChangeCheckpoints = sqliteTable(
  "artifact_change_checkpoints",
  {
    completedAt: text("completed_at"),
    consumerDigest: text("consumer_digest"),
    consumerId: text("consumer_id")
      .notNull()
      .references(() => artifactChangeConsumers.consumerId, { onDelete: "cascade" }),
    consumerItemCount: integer("consumer_item_count").notNull(),
    cursor: text("cursor"),
    generation: text("generation").notNull(),
    phase: text("phase", { enum: ["rebuild", "audit"] }).notNull(),
    snapshotSeq: integer("snapshot_seq").notNull(),
    sourceDigest: text("source_digest"),
    sourceItemCount: integer("source_item_count").notNull(),
    startedAt: text("started_at").notNull(),
    state: text("state", { enum: ["running", "complete"] }).notNull(),
    stream: text("stream").notNull(),
    streamVersion: integer("stream_version").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.consumerId, table.stream, table.streamVersion, table.phase] }),
    check("artifact_change_checkpoints_phase_check", sql`${table.phase} in ('rebuild', 'audit')`),
    check(
      "artifact_change_checkpoints_state_check",
      sql`${table.state} in ('running', 'complete')`,
    ),
    check(
      "artifact_change_checkpoints_value_check",
      sql`${table.streamVersion} >= 1 and ${table.snapshotSeq} >= 0 and ${table.sourceItemCount} >= 0 and ${table.consumerItemCount} >= 0`,
    ),
    check(
      "artifact_change_checkpoints_lifecycle_check",
      sql`(${table.state} = 'running' and ${table.completedAt} is null)
        or (${table.state} = 'complete' and ${table.completedAt} is not null and ${table.sourceDigest} is not null and ${table.consumerDigest} is not null)`,
    ),
  ],
);

export const findings = sqliteTable(
  "findings",
  {
    addedAt: text("added_at").notNull(),
    addedToSpotify: integer("added_to_spotify", { mode: "boolean" }).notNull().default(false),
    addedToSpotifyAt: text("added_to_spotify_at"),

    backfillDiscogsAttemptedAt: text("backfill_discogs_attempted_at"),
    backfillDiscogsAttempts: integer("backfill_discogs_attempts").notNull().default(0),
    backfillDiscogsDoneAt: text("backfill_discogs_done_at"),
    backfillDiscogsFailures: integer("backfill_discogs_failures").notNull().default(0),
    backfillLastfmAttemptedAt: text("backfill_lastfm_attempted_at"),
    backfillLastfmAttempts: integer("backfill_lastfm_attempts").notNull().default(0),
    backfillLastfmDoneAt: text("backfill_lastfm_done_at"),
    backfillLastfmFailures: integer("backfill_lastfm_failures").notNull().default(0),

    backfillNoteAttemptedAt: text("backfill_note_attempted_at"),
    backfillNoteAttempts: integer("backfill_note_attempts").notNull().default(0),
    backfillNoteDoneAt: text("backfill_note_done_at"),
    backfillNoteFailures: integer("backfill_note_failures").notNull().default(0),

    contextNote: text("context_note"),

    contextPromptVersion: integer("context_prompt_version"),

    contextStatus: text("context_status", {
      enum: ["pending", "resolved", "empty", "failed"],
    }),
    enrichmentStatus: text("enrichment_status").notNull().default("pending"),

    galaxyId: text("galaxy_id"),

    logId: text("log_id").unique(),
    note: text("note"),

    notePromptVersion: integer("note_prompt_version"),

    observationAlignmentJson: text("observation_alignment_json"),

    observationAudioUrl: text("observation_audio_url"),
    observationDurationMs: integer("observation_duration_ms"),
    observationGeneratedAt: text("observation_generated_at"),

    observationPromptVersion: integer("observation_prompt_version"),

    observationScript: text("observation_script"),
    postedToTelegram: integer("posted_to_telegram", { mode: "boolean" }).notNull().default(false),
    postedToTelegramAt: text("posted_to_telegram_at"),
    spotifyError: text("spotify_error"),
    telegramError: text("telegram_error"),

    trackId: text("track_id").primaryKey(),

    updatedAt: text("updated_at"),

    videoGrain: text("video_grain"),

    videoModel: text("video_model").default("anthropic/claude-opus-4-8"),

    videoModelReasoning: text("video_model_reasoning").default("high"),

    videoPalette: text("video_palette"),

    videoPlateSubject: text("video_plate_subject"),

    videoRegister: text("video_register"),

    videoSquaredAt: text("video_squared_at"),

    videoStructure: text("video_structure"),
    videoUrl: text("video_url"),

    videoVehicle: text("video_vehicle"),
  },
  (table) => [
    index("findings_added_at_track_id_idx").on(table.addedAt, table.trackId),

    index("findings_galaxy_id_idx").on(table.galaxyId),

    index("findings_video_url_idx").on(table.videoUrl),

    index("findings_enrichment_status_idx").on(table.enrichmentStatus),

    index("findings_render_queue_idx")
      .on(table.addedAt, table.trackId)
      .where(sql`${table.videoUrl} is null`),

    index("findings_video_squared_at_idx")
      .on(table.videoSquaredAt)
      .where(sql`${table.videoUrl} is not null`),
  ],
);

export const radioSchedule = sqliteTable("radio_schedule", {
  epochMs: integer("epoch_ms").notNull(),

  generatedAt: text("generated_at").notNull(),

  service: text("service").primaryKey(),

  version: text("version").notNull(),
});

export const serviceStatus = sqliteTable("service_status", {
  checkedAt: text("checked_at").notNull(),

  latencyMs: integer("latency_ms"),

  message: text("message"),

  service: text("service").primaryKey(),

  since: text("since").notNull(),

  status: text("status", { enum: ["ok", "degraded", "down"] }).notNull(),
});

export const statusEvents = sqliteTable(
  "status_events",
  {
    at: text("at").notNull(),
    id: text("id").primaryKey(),

    message: text("message"),

    service: text("service").notNull(),

    status: text("status", { enum: ["ok", "degraded", "down"] }).notNull(),
  },
  (table) => [index("status_events_at_idx").on(table.at)],
);

export const serviceCheckSamples = sqliteTable(
  "service_check_samples",
  {
    at: text("at").notNull(),
    id: text("id").primaryKey(),

    latencyMs: integer("latency_ms"),

    service: text("service").notNull(),

    status: text("status", { enum: ["ok", "degraded", "down"] }).notNull(),
  },
  (table) => [index("service_check_samples_service_at_idx").on(table.service, table.at)],
);

export const liveState = sqliteTable("live_state", {
  id: text("id").primaryKey(),

  live: integer("live", { mode: "boolean" }).notNull(),

  startedAt: text("started_at"),

  tgMessageId: integer("tg_message_id"),

  title: text("title"),

  updatedAt: text("updated_at").notNull(),
});

export const costEvents = sqliteTable(
  "cost_events",
  {
    costBasis: text("cost_basis", { enum: ["cash", "subsidized"] }).notNull(),

    createdAt: text("created_at").notNull(),

    estimatedUsd: real("estimated_usd"),

    id: text("id").primaryKey(),
    logId: text("log_id"),
    model: text("model"),
    occurredAt: text("occurred_at").notNull(),

    quantity: real("quantity").notNull(),
    source: text("source", { enum: ["measured", "estimated"] }).notNull(),
    step: text("step", {
      enum: [
        "enrich",
        "embed",
        "context",
        "observe",
        "note",
        "bio",
        "video",
        "publish",
        "discogs",
        "lastfm",
        "newsletter",
        "studio-clip",
        "cluster",

        "search",
      ],
    }).notNull(),

    trackId: text("track_id"),
    unitType: text("unit_type", {
      enum: ["tokens", "characters", "seconds", "requests", "emails"],
    }).notNull(),
    vendor: text("vendor", {
      enum: ["anthropic", "openrouter", "cartesia", "firecrawl", "apify", "resend", "self"],
    }).notNull(),
  },
  (table) => [
    index("cost_events_step_occurred_at_idx").on(table.step, table.occurredAt),
    index("cost_events_track_id_occurred_at_idx").on(table.trackId, table.occurredAt),
    index("cost_events_occurred_at_idx").on(table.occurredAt),
  ],
);

export const platformStats = sqliteTable(
  "platform_stats",
  {
    capturedAt: text("captured_at").notNull(),

    id: text("id").primaryKey(),

    metric: text("metric").notNull(),

    platform: text("platform").notNull(),
    value: integer("value").notNull(),
  },
  (table) => [
    index("platform_stats_platform_metric_captured_at_idx").on(
      table.platform,
      table.metric,
      table.capturedAt,
    ),
  ],
);

export const catalogueSnapshots = sqliteTable("catalogue_snapshots", {
  analyzeQueue: integer("analyze_queue").notNull(),

  analyzed: integer("analyzed").notNull(),

  anchorBackoff: integer("anchor_backoff").notNull(),

  anchorQueueIsrc: integer("anchor_queue_isrc").notNull(),

  anchorQueueNoIsrc: integer("anchor_queue_no_isrc").notNull(),

  anchored: integer("anchored").notNull(),

  captureQueue: integer("capture_queue").notNull(),

  captured: integer("captured").notNull(),

  certified: integer("certified").notNull(),

  crawled: integer("crawled").notNull(),
  createdAt: text("created_at").notNull(),

  day: text("day").primaryKey(),

  embedQueue: integer("embed_queue").notNull(),

  embedded: integer("embedded").notNull(),

  frontierDone: integer("frontier_done").notNull(),

  frontierPending: integer("frontier_pending").notNull(),

  recEligible: integer("rec_eligible").notNull(),
});

export const spotifyAuth = sqliteTable("spotify_auth", {
  accessToken: text("access_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  refreshToken: text("refresh_token").notNull(),
  scope: text("scope").notNull(),
  service: text("service").primaryKey(),
  updatedAt: text("updated_at").notNull(),
});

export const youtubeAuth = sqliteTable("youtube_auth", {
  accessToken: text("access_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  refreshToken: text("refresh_token").notNull(),
  scope: text("scope").notNull(),
  service: text("service").primaryKey(),
  updatedAt: text("updated_at").notNull(),
});

export const mixcloudAuth = sqliteTable("mixcloud_auth", {
  accessToken: text("access_token").notNull(),
  service: text("service").primaryKey(),
  updatedAt: text("updated_at").notNull(),
});

export const twitchAuth = sqliteTable("twitch_auth", {
  accessToken: text("access_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  refreshToken: text("refresh_token").notNull(),
  scope: text("scope").notNull(),
  service: text("service").primaryKey(),
  updatedAt: text("updated_at").notNull(),
});

export const tiktokAuth = sqliteTable("tiktok_auth", {
  accessToken: text("access_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  refreshToken: text("refresh_token").notNull(),
  scope: text("scope").notNull(),
  service: text("service").primaryKey(),
  updatedAt: text("updated_at").notNull(),
});

export const instagramAuth = sqliteTable("instagram_auth", {
  accessToken: text("access_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  service: text("service").primaryKey(),
  updatedAt: text("updated_at").notNull(),
});

export const submissions = sqliteTable(
  "submissions",
  {
    album: text("album"),
    artistsJson: text("artists_json").notNull(),
    artworkUrl: text("artwork_url"),
    contact: text("contact"),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    note: text("note"),
    reviewedAt: text("reviewed_at"),
    source: text("source", { enum: ["web", "cli", "ssh"] }).notNull(),
    spotifyTrackId: text("spotify_track_id").notNull(),
    spotifyUrl: text("spotify_url").notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull(),
    submitterHash: text("submitter_hash").notNull(),
    title: text("title").notNull(),

    triagePromptVersion: integer("triage_prompt_version"),

    triageVerdict: text("triage_verdict"),
    userId: text("user_id"),
  },
  (table) => [
    index("submissions_status_created_at_idx").on(table.status, table.createdAt),
    index("submissions_spotify_track_id_idx").on(table.spotifyTrackId),
    index("submissions_submitter_hash_created_at_idx").on(table.submitterHash, table.createdAt),
    index("submissions_user_id_created_at_idx").on(table.userId, table.createdAt),
  ],
);

export const user = sqliteTable("user", {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),

  crewNumber: integer("crew_number").unique(),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  displayUsername: text("display_username"),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
  id: text("id").primaryKey(),
  image: text("image"),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
  name: text("name").notNull(),
  status: text("status", { enum: ["active", "suspended", "deleted"] })
    .default("active")
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
  username: text("username").unique(),
});

export const session = sqliteTable(
  "session",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    ipAddress: text("ip_address"),
    token: text("token").notNull().unique(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    accessToken: text("access_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    accountId: text("account_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    id: text("id").primaryKey(),
    idToken: text("id_token"),
    password: text("password"),
    providerId: text("provider_id").notNull(),
    refreshToken: text("refresh_token"),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
    value: text("value").notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const deviceCode = sqliteTable(
  "device_code",
  {
    clientId: text("client_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    deviceCode: text("device_code").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    lastPolledAt: integer("last_polled_at", { mode: "timestamp_ms" }),
    pollingInterval: integer("polling_interval"),
    scope: text("scope"),
    status: text("status").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
    userCode: text("user_code").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("device_code_device_code_idx").on(table.deviceCode),
    index("device_code_user_code_idx").on(table.userCode),
  ],
);

export const rateLimitEvents = sqliteTable(
  "rate_limit_events",
  {
    action: text("action").notNull(),
    bucket: text("bucket").notNull(),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    userId: text("user_id"),
  },
  (table) => [
    index("rate_limit_action_bucket_created_at_idx").on(
      table.action,
      table.bucket,
      table.createdAt,
    ),
    index("rate_limit_user_action_created_at_idx").on(table.userId, table.action, table.createdAt),
    index("rate_limit_ip_action_created_at_idx").on(table.ipHash, table.action, table.createdAt),
  ],
);

export const rateLimitCounters = sqliteTable(
  "rate_limit_counters",
  {
    action: text("action").notNull(),
    bucket: text("bucket").notNull(),
    count: integer("count").notNull().default(0),

    windowStart: text("window_start").notNull(),
  },
  (table) => [
    uniqueIndex("rate_limit_counter_action_bucket_window_idx").on(
      table.action,
      table.bucket,
      table.windowStart,
    ),
  ],
);

export const userGalaxyState = sqliteTable("user_galaxy_state", {
  createdAt: text("created_at").notNull(),
  deaths: integer("deaths").notNull().default(0),
  lastPlayedAt: text("last_played_at"),
  schemaVersion: integer("schema_version").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
  userId: text("user_id").primaryKey(),
  wins: integer("wins").notNull().default(0),
});

export const userGalaxyCollections = sqliteTable(
  "user_galaxy_collections",
  {
    firstCollectedAt: text("first_collected_at").notNull(),
    id: text("id").primaryKey(),
    lastCollectedAt: text("last_collected_at").notNull(),
    logId: text("log_id").notNull(),
    sourceSurface: text("source_surface", { enum: ["web", "cli", "ssh", "mcp"] }).notNull(),
    trackId: text("track_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    uniqueIndex("user_galaxy_collections_user_track_idx").on(table.userId, table.trackId),
    index("user_galaxy_collections_user_first_idx").on(table.userId, table.firstCollectedAt),
    index("user_galaxy_collections_track_first_idx").on(table.trackId, table.firstCollectedAt),
  ],
);

export const userRecSeeds = sqliteTable(
  "user_rec_seeds",
  {
    addedAt: text("added_at").notNull(),
    trackId: text("track_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.trackId] }),
    index("user_rec_seeds_user_idx").on(table.userId),
  ],
);

export const userFrontierPlaylists = sqliteTable("user_frontier_playlists", {
  coverUploadedAt: text("cover_uploaded_at"),
  createdAt: text("created_at").notNull(),
  lastSyncedAt: text("last_synced_at"),
  lastUriHash: text("last_uri_hash"),
  playlistId: text("playlist_id").notNull(),
  userId: text("user_id").primaryKey(),
});

export const userFrontierRefresh = sqliteTable("user_frontier_refresh", {
  refreshedAt: text("refreshed_at").notNull(),
  userId: text("user_id").primaryKey(),
});

export const frontierEditions = sqliteTable(
  "frontier_editions",
  {
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    number: integer("number").notNull(),
    seedsSkippedJson: text("seeds_skipped_json"),
    seedsUsed: integer("seeds_used"),
    userId: text("user_id").notNull(),
  },
  (table) => [uniqueIndex("frontier_editions_user_number_idx").on(table.userId, table.number)],
);

export const frontierEditionTracks = sqliteTable(
  "frontier_edition_tracks",
  {
    artistsText: text("artists_text").notNull(),
    bpm: integer("bpm"),
    coverUrl: text("cover_url"),
    durationMs: integer("duration_ms"),
    editionId: text("edition_id").notNull(),
    key: text("key"),
    logId: text("log_id"),
    position: integer("position").notNull(),
    similarity: real("similarity"),
    slot: text("slot", { enum: ["finding", "catalogue"] }).notNull(),
    spotifyUri: text("spotify_uri"),
    spotifyUrl: text("spotify_url"),
    titleText: text("title_text").notNull(),
    trackId: text("track_id").notNull(),
  },
  (table) => [
    uniqueIndex("frontier_edition_tracks_edition_position_idx").on(table.editionId, table.position),
    index("frontier_edition_tracks_edition_id_idx").on(table.editionId),
  ],
);

export const userSavedFindings = sqliteTable(
  "user_saved_findings",
  {
    id: text("id").primaryKey(),
    logId: text("log_id"),
    note: text("note"),
    savedAt: text("saved_at").notNull(),
    trackId: text("track_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [uniqueIndex("user_saved_findings_user_track_idx").on(table.userId, table.trackId)],
);

export const userSavedSets = sqliteTable(
  "user_saved_sets",
  {
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    setTokens: text("set_tokens").notNull(),
    taste: text("taste"),
    updatedAt: text("updated_at").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [index("user_saved_sets_user_updated_idx").on(table.userId, table.updatedAt)],
);

export const userWatches = sqliteTable(
  "user_watches",
  {
    createdAt: text("created_at").notNull(),
    entityId: text("entity_id").notNull(),
    id: text("id").primaryKey(),
    includeSimilar: integer("include_similar", { mode: "boolean" }).notNull().default(false),
    kind: text("kind", { enum: ["artist", "label"] }).notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    uniqueIndex("user_watches_user_kind_entity_idx").on(table.userId, table.kind, table.entityId),

    index("user_watches_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const userPreferences = sqliteTable("user_preferences", {
  preferences: text("preferences").notNull().default("{}"),
  updatedAt: text("updated_at").notNull(),
  userId: text("user_id").primaryKey(),
});

export const userDataExports = sqliteTable(
  "user_data_exports",
  {
    completedAt: text("completed_at"),
    expiresAt: text("expires_at").notNull(),
    id: text("id").primaryKey(),
    r2Key: text("r2_key"),
    requestedAt: text("requested_at").notNull(),
    status: text("status", { enum: ["pending", "completed", "failed"] }).notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [index("user_data_exports_user_requested_idx").on(table.userId, table.requestedAt)],
);

export const userDeletionRequests = sqliteTable(
  "user_deletion_requests",
  {
    completedAt: text("completed_at"),
    id: text("id").primaryKey(),
    mode: text("mode", { enum: ["delete"] }).notNull(),
    requestedAt: text("requested_at").notNull(),
    status: text("status", { enum: ["pending", "completed", "failed"] }).notNull(),
    summaryJson: text("summary_json").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    index("user_deletion_requests_user_requested_idx").on(table.userId, table.requestedAt),
  ],
);

export const socialPosts = sqliteTable(
  "social_posts",
  {
    createdAt: text("created_at").notNull(),
    externalId: text("external_id"),
    id: text("id").primaryKey(),
    platform: text("platform", { enum: ["tiktok", "youtube"] }).notNull(),
    publishedAt: text("published_at"),
    scheduledFor: text("scheduled_for"),
    status: text("status", { enum: ["draft", "scheduled", "published", "failed"] }).notNull(),
    trackId: text("track_id").notNull(),
    updatedAt: text("updated_at").notNull(),
    url: text("url"),
  },
  (table) => [uniqueIndex("social_posts_track_platform_idx").on(table.trackId, table.platform)],
);

export const socialMetrics = sqliteTable(
  "social_metrics",
  {
    averageViewDurationSeconds: integer("average_view_duration_seconds"),

    averageViewPercentage: real("average_view_percentage"),

    capturedAt: text("captured_at").notNull(),

    capturedDay: text("captured_day").notNull(),
    comments: integer("comments"),
    createdAt: text("created_at").notNull(),

    externalId: text("external_id").notNull(),
    id: text("id").primaryKey(),
    impressions: integer("impressions"),
    likes: integer("likes"),

    platform: text("platform", { enum: ["tiktok", "youtube"] }).notNull(),
    saves: integer("saves"),
    shares: integer("shares"),

    source: text("source", { enum: ["postiz", "youtube_analytics", "tiktok_display", "csv"] })
      .notNull()
      .default("postiz"),

    trackId: text("track_id").notNull(),
    views: integer("views"),

    watchTimeSeconds: integer("watch_time_seconds"),
  },
  (table) => [
    uniqueIndex("social_metrics_external_source_day_idx").on(
      table.externalId,
      table.source,
      table.capturedDay,
    ),

    index("social_metrics_track_captured_at_idx").on(table.trackId, table.capturedAt),
  ],
);

export const mixtapes = sqliteTable(
  "mixtapes",
  {
    addedAt: text("added_at"),

    announcedAt: text("announced_at"),
    createdAt: text("created_at").notNull(),
    durationMs: integer("duration_ms"),
    id: text("id").primaryKey(),
    logId: text("log_id").unique(),
    note: text("note"),

    publishedAt: text("published_at"),
    recordedAt: text("recorded_at"),

    recordingId: text("recording_id"),
    sequenceNumber: integer("sequence_number").unique(),

    setVideoAt: text("set_video_at"),

    status: text("status", { enum: ["distributing", "published"] })
      .notNull()
      .default(sql`'draft'`),
    title: text("title").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("mixtapes_recording_id_idx").on(table.recordingId)],
);

export const mixtapeSocialPosts = sqliteTable(
  "mixtape_social_posts",
  {
    createdAt: text("created_at").notNull(),
    externalId: text("external_id"),
    id: text("id").primaryKey(),
    mixtapeId: text("mixtape_id").notNull(),
    platform: text("platform", { enum: ["youtube", "mixcloud", "soundcloud"] }).notNull(),
    publishedAt: text("published_at"),
    status: text("status", { enum: ["uploading", "published", "failed"] }).notNull(),
    updatedAt: text("updated_at").notNull(),
    url: text("url"),
  },
  (table) => [
    uniqueIndex("mixtape_social_posts_mixtape_platform_idx").on(table.mixtapeId, table.platform),
  ],
);

export const pushTokens = sqliteTable(
  "push_tokens",
  {
    appVersion: text("app_version"),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    mutedJson: text("muted_json"),
    platform: text("platform", { enum: ["android", "ios"] }).notNull(),
    token: text("token").primaryKey(),
    userId: text("user_id"),
  },
  (table) => [
    index("push_tokens_user_id_idx").on(table.userId),
    index("push_tokens_last_seen_at_idx").on(table.lastSeenAt),
  ],
);

export const pushReceipts = sqliteTable(
  "push_receipts",
  {
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    token: text("token").notNull(),
  },
  (table) => [index("push_receipts_created_at_idx").on(table.createdAt)],
);

export const mixtapeTracks = sqliteTable(
  "mixtape_tracks",
  {
    artistsText: text("artists_text"),
    findingId: text("finding_id"),
    mixtapeId: text("mixtape_id").notNull(),
    position: integer("position").notNull(),
    startMs: integer("start_ms"),
    titleText: text("title_text"),
    trackId: text("track_id").notNull(),
  },
  (table) => [
    index("mixtape_tracks_mixtape_id_idx").on(table.mixtapeId),
    uniqueIndex("mixtape_tracks_mixtape_position_idx").on(table.mixtapeId, table.position),
    uniqueIndex("mixtape_tracks_mixtape_track_idx").on(table.mixtapeId, table.trackId),
    index("mixtape_tracks_finding_id_idx").on(table.findingId),

    index("mixtape_tracks_track_id_idx").on(table.trackId),
  ],
);

export const mixtapeClips = sqliteTable(
  "mixtape_clips",
  {
    caption: text("caption"),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    inMs: integer("in_ms").notNull(),
    outMs: integer("out_ms").notNull(),

    recordingId: text("recording_id"),
    status: text("status", { enum: ["pending", "done"] })
      .notNull()
      .default("pending"),
    updatedAt: text("updated_at").notNull(),
    xOffset: integer("x_offset").notNull(),
  },
  (table) => [index("mixtape_clips_recording_id_idx").on(table.recordingId)],
);

export const mixtapeClipSocialPosts = sqliteTable(
  "mixtape_clip_social_posts",
  {
    caption: text("caption"),
    clipId: text("clip_id").notNull(),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    platform: text("platform", { enum: ["instagram"] }).notNull(),
    postedUrl: text("posted_url"),
    postizId: text("postiz_id"),
    scheduledFor: text("scheduled_for").notNull(),
    status: text("status", { enum: ["scheduled", "posted", "failed"] }).notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("mixtape_clip_social_posts_clip_platform_idx").on(table.clipId, table.platform),
    index("mixtape_clip_social_posts_status_idx").on(table.status),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const noteRejections = sqliteTable(
  "note_rejections",
  {
    attempts: integer("attempts").notNull().default(1),

    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),

    maxOverlap: real("max_overlap").notNull(),

    minPhraseWords: integer("min_phrase_words").notNull(),

    neighborLogId: text("neighbor_log_id"),

    neighborNote: text("neighbor_note"),

    note: text("note").notNull(),

    overlap: real("overlap").notNull(),

    phrase: text("phrase").notNull().default(""),

    resolution: text("resolution", { enum: ["accepted", "discarded"] }),
    resolvedAt: text("resolved_at"),

    trackId: text("track_id").notNull(),

    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("note_rejections_open_track_idx")
      .on(table.trackId)
      .where(sql`${table.resolvedAt} is null`),

    index("note_rejections_open_idx").on(table.resolvedAt, table.createdAt),
  ],
);

export const observationRejections = sqliteTable(
  "observation_rejections",
  {
    attempts: integer("attempts").notNull().default(1),

    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),

    maxOverlap: real("max_overlap").notNull(),

    minPhraseWords: integer("min_phrase_words").notNull(),

    neighborLogId: text("neighbor_log_id"),

    neighborScript: text("neighbor_script"),

    overlap: real("overlap").notNull(),

    phrase: text("phrase").notNull().default(""),

    resolution: text("resolution", { enum: ["accepted", "discarded"] }),
    resolvedAt: text("resolved_at"),

    script: text("script").notNull(),

    trackId: text("track_id").notNull(),

    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("observation_rejections_open_track_idx")
      .on(table.trackId)
      .where(sql`${table.resolvedAt} is null`),

    index("observation_rejections_open_idx").on(table.resolvedAt, table.createdAt),
  ],
);

export const promptVersions = sqliteTable(
  "prompt_versions",
  {
    body: text("body").notNull(),
    createdAt: text("created_at").notNull(),

    createdBy: text("created_by", { enum: ["operator", "agent"] })
      .notNull()
      .default("operator"),
    id: text("id").primaryKey(),

    note: text("note"),

    slug: text("slug").notNull(),

    version: integer("version").notNull(),
  },
  (table) => [uniqueIndex("prompt_versions_slug_version_idx").on(table.slug, table.version)],
);

export const logbookEntries = sqliteTable("logbook_entries", {
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),

  generatedAt: text("generated_at").notNull(),

  generatedBy: text("generated_by", { enum: ["agent", "operator"] })
    .notNull()
    .default("agent"),

  promptVersion: integer("prompt_version"),

  sector: integer("sector").primaryKey(),

  title: text("title").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const recordings = sqliteTable(
  "recordings",
  {
    createdAt: text("created_at").notNull(),
    durationMs: integer("duration_ms"),

    id: text("id").primaryKey(),

    note: text("note"),

    parentId: text("parent_id"),

    plannedFor: text("planned_for"),

    r2Key: text("r2_key"),
    recordedAt: text("recorded_at"),
    title: text("title").notNull(),

    updatedAt: text("updated_at").notNull(),

    version: integer("version").notNull().default(1),
  },
  (table) => [
    index("recordings_parent_id_idx").on(table.parentId),

    uniqueIndex("recordings_parent_version_idx").on(table.parentId, table.version),
  ],
);

export const recordingCues = sqliteTable(
  "recording_cues",
  {
    artistsText: text("artists_text"),
    createdAt: text("created_at").notNull(),
    findingId: text("finding_id"),

    id: text("id").primaryKey(),
    position: integer("position").notNull(),
    recordingId: text("recording_id").notNull(),
    startMs: integer("start_ms"),
    titleText: text("title_text"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("recording_cues_recording_position_idx").on(table.recordingId, table.position),
    index("recording_cues_recording_id_idx").on(table.recordingId),
    index("recording_cues_finding_id_idx").on(table.findingId),

    check("recording_cues_position_positive", sql`"position" >= 1`),
    check("recording_cues_start_ms_non_negative", sql`"start_ms" is null or "start_ms" >= 0`),
  ],
);

export const artists = sqliteTable(
  "artists",
  {
    bio: text("bio"),

    bioGateBypassedAt: text("bio_gate_bypassed_at"),

    bioPromptVersion: integer("bio_prompt_version"),

    bioStatus: text("bio_status", { enum: ["pending", "resolved", "empty", "failed"] }),

    bioVoiceViolations: text("bio_voice_violations"),

    certifiedFindingCount: integer("certified_finding_count").notNull().default(0),
    createdAt: text("created_at").notNull(),

    discogsUrl: text("discogs_url"),
    id: text("id").primaryKey(),

    imageAttemptedAt: text("image_attempted_at"),
    imageFailures: integer("image_failures").notNull().default(0),
    imageKey: text("image_key"),
    imageSource: text("image_source", { enum: ["apple", "coverart", "spotify"] }),
    imageState: text("image_state", { enum: ["pending", "resolved", "none"] })
      .notNull()
      .default("pending"),
    imageUpdatedAt: text("image_updated_at"),

    imageUrl: text("image_url"),

    lastfmUrl: text("lastfm_url"),
    mbid: text("mbid"),
    name: text("name").notNull(),

    rankableTrackCount: integer("rankable_track_count").notNull().default(0),

    renderableTrackCount: integer("renderable_track_count").notNull().default(0),
    resolvedAt: text("resolved_at"),

    reviewedAt: text("reviewed_at"),
    slug: text("slug").notNull().unique(),
    spotifyArtistId: text("spotify_artist_id").unique(),
    spotifyUrl: text("spotify_url"),
    updatedAt: text("updated_at").notNull(),
    wikidataQid: text("wikidata_qid"),
  },
  (table) => [
    index("artists_name_idx").on(table.name),

    index("artists_name_nocase_idx").on(sql`${table.name} collate nocase`, table.slug),

    index("artists_mixable_order_idx")
      .on(sql`-${table.rankableTrackCount}`, table.name, table.slug)
      .where(sql`${table.rankableTrackCount} > 0`),

    index("artists_renderable_count_idx").on(table.renderableTrackCount),

    uniqueIndex("artists_hub_listing_idx")
      .on(table.slug)
      .where(sql`(${table.certifiedFindingCount} > 0 or ${table.renderableTrackCount} >= 3)`),

    index("artists_mbid_idx").on(table.mbid, table.slug),

    index("artists_bio_review_queue_idx")
      .on(table.bioGateBypassedAt)
      .where(sql`${table.bioGateBypassedAt} is not null`),
  ],
);

export const galaxies = sqliteTable("galaxies", {
  centroidJson: text("centroid_json").notNull(),
  createdAt: text("created_at").notNull(),
  handle: text("handle").notNull().unique(),
  id: text("id").primaryKey(),
  name: text("name"),
  retiredAt: text("retired_at"),
  slug: text("slug").unique(),
  splitRequestedAt: text("split_requested_at"),
  updatedAt: text("updated_at").notNull(),
});

export const trackArtists = sqliteTable(
  "track_artists",
  {
    artistId: text("artist_id").notNull(),
    position: integer("position").notNull(),
    role: text("role", { enum: ["remixer"] }),
    trackId: text("track_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.trackId, table.artistId] }),
    index("track_artists_track_id_idx").on(table.trackId),
    index("track_artists_artist_id_idx").on(table.artistId),
  ],
);

export const artistCentroids = sqliteTable("artist_centroids", {
  artistId: text("artist_id").primaryKey(),
  centroidBlob: float32Vector("centroid_blob").notNull(),
  computedAt: text("computed_at").notNull(),
  rankCorpus: text("rank_corpus").notNull(),
  vectorCount: integer("vector_count").notNull(),
});

export const artistSimilar = sqliteTable(
  "artist_similar",
  {
    artistId: text("artist_id").notNull(),
    computedAt: text("computed_at").notNull(),
    neighbourArtistId: text("neighbour_artist_id").notNull(),
    rank: integer("rank").notNull(),
    rankCorpus: text("rank_corpus").notNull(),
    similarity: real("similarity").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.artistId, table.rank] }),
    index("artist_similar_neighbour_idx").on(table.neighbourArtistId),
  ],
);

export const artistSocials = sqliteTable(
  "artist_socials",
  {
    artistId: text("artist_id").notNull(),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    platform: text("platform", {
      enum: [
        "spotify",
        "youtube",
        "mixcloud",
        "soundcloud",
        "instagram",
        "tiktok",
        "bluesky",
        "bandcamp",
        "beatport",
        "twitter",
        "facebook",
        "twitch",
        "homepage",
      ],
    }).notNull(),

    reviewedAt: text("reviewed_at"),
    source: text("source", { enum: ["musicbrainz", "firecrawl", "operator"] }).notNull(),
    status: text("status", { enum: ["auto", "candidate", "confirmed"] }).notNull(),
    updatedAt: text("updated_at").notNull(),
    url: text("url").notNull(),
  },
  (table) => [
    uniqueIndex("artist_socials_artist_platform_idx").on(table.artistId, table.platform),

    index("artist_socials_unreviewed_idx").on(table.reviewedAt),
    index("artist_socials_platform_idx").on(table.platform),

    index("artist_socials_candidate_idx")
      .on(table.artistId)
      .where(sql`${table.status} = 'candidate'`),
  ],
);

export const labels = sqliteTable(
  "labels",
  {
    bio: text("bio"),

    bioGateBypassedAt: text("bio_gate_bypassed_at"),

    bioPromptVersion: integer("bio_prompt_version"),

    bioStatus: text("bio_status", { enum: ["pending", "resolved", "empty", "failed"] }),

    bioVoiceViolations: text("bio_voice_violations"),

    certifiedFindingCount: integer("certified_finding_count").notNull().default(0),
    createdAt: text("created_at").notNull(),

    disambiguation: text("disambiguation"),

    discogsLabelId: integer("discogs_label_id"),

    foundedLocation: text("founded_location"),

    foundingDate: text("founding_date"),
    id: text("id").primaryKey(),

    imageAttemptedAt: text("image_attempted_at"),

    imageFailures: integer("image_failures").notNull().default(0),

    imageKey: text("image_key"),

    imageState: text("image_state", { enum: ["pending", "resolved", "none"] })
      .notNull()
      .default("pending"),

    imageUpdatedAt: text("image_updated_at"),

    labelReleasesAttemptedAt: text("label_releases_attempted_at"),
    labelReleasesCheckedAt: text("label_releases_checked_at"),
    labelReleasesFailures: integer("label_releases_failures").notNull().default(0),

    lineageAttemptedAt: text("lineage_attempted_at"),
    lineageFailures: integer("lineage_failures").notNull().default(0),
    lineageState: text("lineage_state", { enum: ["pending", "resolved", "none"] })
      .notNull()
      .default("pending"),

    mbLabelId: text("mb_label_id"),

    name: text("name").notNull(),

    parentLabelId: text("parent_label_id"),

    renderableTrackCount: integer("renderable_track_count").notNull().default(0),
    ruledAt: text("ruled_at"),

    scopeChangedAt: text("scope_changed_at"),
    seedState: text("seed_state", { enum: ["enabled", "disabled", "undecided"] })
      .notNull()
      .default("undecided"),
    slug: text("slug").notNull().unique(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("labels_mb_label_id_idx").on(table.mbLabelId),

    index("labels_parent_label_id_idx").on(table.parentLabelId),

    index("labels_lineage_queue_idx")
      .on(table.slug)
      .where(sql`${table.lineageState} = 'pending'`),

    index("labels_label_releases_queue_idx")
      .on(table.labelReleasesCheckedAt)
      .where(sql`${table.seedState} = 'enabled'`),

    index("labels_undecided_queue_idx")
      .on(table.createdAt)
      .where(sql`${table.seedState} = 'undecided'`),

    index("labels_seed_state_name_idx").on(table.seedState, sql`${table.name} collate nocase`),

    index("labels_renderable_count_idx").on(table.renderableTrackCount),

    uniqueIndex("labels_hub_listing_idx")
      .on(table.slug)
      .where(sql`(${table.certifiedFindingCount} > 0 or ${table.renderableTrackCount} >= 3)`),

    index("labels_name_nocase_idx").on(sql`${table.name} collate nocase`),

    index("labels_bio_review_queue_idx")
      .on(table.bioGateBypassedAt)
      .where(sql`${table.bioGateBypassedAt} is not null`),
  ],
);

export const artistRules = sqliteTable(
  "artist_rules",
  {
    artistMbid: text("artist_mbid").notNull(),
    artistName: text("artist_name").notNull(),
    artistSpotifyId: text("artist_spotify_id"),
    checkedAt: text("checked_at"),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    labelId: text("label_id"),
    rearmedAt: text("rearmed_at"),
    resolvedMbid: text("resolved_mbid"),
    resolvedName: text("resolved_name"),
    source: text("source", { enum: ["operator", "triage"] }).notNull(),
    updatedAt: text("updated_at").notNull(),
    verdict: text("verdict", { enum: ["allow", "block", "unlisted"] }).notNull(),
  },
  (table) => [
    uniqueIndex("artist_rules_label_artist_idx")
      .on(table.labelId, table.artistMbid)
      .where(sql`${table.labelId} is not null`),
    uniqueIndex("artist_rules_global_artist_idx")
      .on(table.artistMbid)
      .where(sql`${table.labelId} is null`),
    index("artist_rules_label_id_idx").on(table.labelId),
    index("artist_rules_crawl_lookup_idx").on(table.artistMbid, table.verdict, table.rearmedAt),
  ],
);

export const labelAliases = sqliteTable(
  "label_aliases",
  {
    alias: text("alias").notNull(),
    aliasSlug: text("alias_slug").notNull(),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["name", "hint"] }).notNull(),
    labelId: text("label_id").notNull(),
    source: text("source", {
      enum: ["operator", "apple", "musicbrainz", "discogs", "spotify"],
    }).notNull(),
    status: text("status", { enum: ["candidate", "confirmed"] }).notNull(),
  },
  (table) => [
    uniqueIndex("label_aliases_label_slug_source_idx").on(
      table.labelId,
      table.aliasSlug,
      table.source,
    ),

    index("label_aliases_alias_slug_idx").on(table.aliasSlug),

    index("label_aliases_status_idx").on(table.status),
  ],
);

export const artistAliases = sqliteTable(
  "artist_aliases",
  {
    alias: text("alias").notNull(),
    aliasSlug: text("alias_slug").notNull(),
    artistId: text("artist_id").notNull(),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["name", "hint"] }).notNull(),
    source: text("source", {
      enum: ["operator", "musicbrainz", "discogs", "spotify"],
    }).notNull(),
    status: text("status", { enum: ["auto", "confirmed"] }).notNull(),
  },
  (table) => [
    uniqueIndex("artist_aliases_artist_slug_source_idx").on(
      table.artistId,
      table.aliasSlug,
      table.source,
    ),

    index("artist_aliases_artist_id_idx").on(table.artistId),
    index("artist_aliases_alias_slug_idx").on(table.aliasSlug),
  ],
);

export const albums = sqliteTable(
  "albums",
  {
    appleAlbumId: text("apple_album_id"),
    artworkBgColor: text("artwork_bg_color"),
    artworkHeight: integer("artwork_height"),
    artworkTextColor1: text("artwork_text_color1"),
    artworkTextColor2: text("artwork_text_color2"),
    artworkTextColor3: text("artwork_text_color3"),
    artworkTextColor4: text("artwork_text_color4"),
    artworkUrlTemplate: text("artwork_url_template"),
    artworkWidth: integer("artwork_width"),

    bio: text("bio"),

    bioGateBypassedAt: text("bio_gate_bypassed_at"),

    bioPromptVersion: integer("bio_prompt_version"),

    bioStatus: text("bio_status", { enum: ["pending", "resolved", "empty", "failed"] }),

    bioVoiceViolations: text("bio_voice_violations"),

    certifiedFindingCount: integer("certified_finding_count").notNull().default(0),
    createdAt: text("created_at").notNull(),

    discogsAttemptedAt: text("discogs_attempted_at"),
    discogsCatno: text("discogs_catno"),
    discogsFailures: integer("discogs_failures").notNull().default(0),
    discogsState: text("discogs_state", { enum: ["pending", "resolved", "none"] })
      .notNull()
      .default("pending"),
    discogsStyles: text("discogs_styles"),
    id: text("id").primaryKey(),

    imageAttemptedAt: text("image_attempted_at"),
    imageFailures: integer("image_failures").notNull().default(0),
    imageKey: text("image_key"),
    imageSource: text("image_source", { enum: ["apple", "coverart", "spotify"] }),
    imageState: text("image_state", { enum: ["pending", "resolved", "none"] })
      .notNull()
      .default("pending"),
    imageUpdatedAt: text("image_updated_at"),

    name: text("name").notNull(),
    recordLabelRaw: text("record_label_raw"),

    releaseGroupMbid: text("release_group_mbid"),

    renderableTrackCount: integer("renderable_track_count").notNull().default(0),
    slug: text("slug").notNull().unique(),
    upc: text("upc"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("albums_release_group_mbid_idx").on(table.releaseGroupMbid),

    index("albums_renderable_count_idx").on(table.renderableTrackCount),

    uniqueIndex("albums_hub_listing_idx")
      .on(table.slug)
      .where(sql`(${table.certifiedFindingCount} > 0 or ${table.renderableTrackCount} >= 3)`),

    index("albums_name_nocase_idx").on(sql`${table.name} collate nocase`),

    index("albums_bio_review_queue_idx")
      .on(table.bioGateBypassedAt)
      .where(sql`${table.bioGateBypassedAt} is not null`),
  ],
);

export const crawlFrontier = sqliteTable(
  "crawl_frontier",
  {
    attemptedAt: text("attempted_at"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: text("created_at").notNull(),

    cursor: integer("cursor").notNull().default(0),

    demandRank: integer("demand_rank").notNull().default(1),
    doneAt: text("done_at"),

    externalId: text("external_id").notNull(),
    failures: integer("failures").notNull().default(0),
    hop: integer("hop").notNull(),
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["artist", "label", "release"] }).notNull(),

    labelSlug: text("label_slug"),

    note: text("note"),
    parentId: text("parent_id"),

    releaseLabelSlug: text("release_label_slug"),
    source: text("source", { enum: ["fluncle", "musicbrainz"] }).notNull(),

    state: text("state", { enum: ["done", "failed", "pending", "skipped"] })
      .notNull()
      .default("pending"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("crawl_frontier_pick_idx").on(
      table.state,
      table.hop,
      table.demandRank,
      table.createdAt,
      table.id,
    ),

    index("crawl_frontier_label_idx").on(table.labelSlug),

    index("crawl_frontier_demand_rank0_idx")
      .on(table.state)
      .where(sql`${table.demandRank} = 0`),

    index("crawl_frontier_label_node_idx")
      .on(table.state, table.doneAt)
      .where(sql`${table.kind} = 'label' and ${table.source} = 'musicbrainz'`),
  ],
);

export const editions = sqliteTable("editions", {
  addedAt: text("added_at"),

  contentJson: text("content_json").notNull(),
  createdAt: text("created_at").notNull(),
  id: text("id").primaryKey(),

  number: integer("number").unique(),

  promptVersion: integer("prompt_version"),

  sendExternalId: text("send_external_id"),
  sendProvider: text("send_provider"),
  sentAt: text("sent_at"),
  status: text("status", { enum: ["draft", "sent"] })
    .notNull()
    .default("draft"),
  subject: text("subject"),
  updatedAt: text("updated_at").notNull(),

  windowSince: text("window_since"),
  windowUntil: text("window_until"),
});

export const subscriptions = sqliteTable("subscriptions", {
  amount: integer("amount").notNull(),

  billingUrl: text("billing_url"),

  cadence: text("cadence", { enum: ["monthly", "annual", "one-off", "usage"] }).notNull(),

  category: text("category", {
    enum: ["infra", "AI", "media", "distribution", "domains", "tooling"],
  }).notNull(),
  createdAt: text("created_at").notNull(),

  currency: text("currency").notNull().default("EUR"),
  id: text("id").primaryKey(),

  name: text("name").notNull(),

  notes: text("notes"),

  powers: text("powers"),

  renewsAt: text("renews_at"),

  status: text("status", { enum: ["active", "cancelled", "trial"] })
    .notNull()
    .default("active"),
  updatedAt: text("updated_at").notNull(),

  vendor: text("vendor").notNull(),
});

export const exchangeRates = sqliteTable("exchange_rates", {
  base: text("base").primaryKey(),
  fetchedAt: text("fetched_at").notNull(),
  ratesDate: text("rates_date").notNull(),
  ratesJson: text("rates_json").notNull(),
});

export const hubPageAnchors = sqliteTable(
  "hub_page_anchors",
  {
    anchorsJson: text("anchors_json").notNull(),
    clauseHash: text("clause_hash").notNull(),
    computedAt: text("computed_at").notNull(),
    fingerprint: text("fingerprint").notNull(),
    hub: text("hub").notNull(),
  },
  (table) => [primaryKey({ columns: [table.hub, table.clauseHash] })],
);

export const hubPageAnchorValidity = sqliteTable(
  "hub_page_anchor_validity",
  {
    anchorFormatVersion: integer("anchor_format_version").notNull(),
    clauseHash: text("clause_hash").notNull(),
    generation: text("generation").notNull(),
    hub: text("hub").notNull(),
    orderEpoch: integer("order_epoch").notNull(),
    publishedAt: text("published_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.hub, table.clauseHash] }),
    check(
      "hub_page_anchor_validity_version_check",
      sql`${table.anchorFormatVersion} >= 1 and ${table.orderEpoch} >= 0`,
    ),
  ],
);
