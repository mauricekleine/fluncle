import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const tracks = sqliteTable("tracks", {
  addedAt: text("added_at").notNull(),
  addedToSpotify: integer("added_to_spotify", { mode: "boolean" }).notNull().default(false),
  addedToSpotifyAt: text("added_to_spotify_at"),
  album: text("album"),
  albumImageUrl: text("album_image_url"),
  artistsJson: text("artists_json").notNull(),
  bpm: real("bpm"),
  durationMs: integer("duration_ms").notNull(),
  enrichmentStatus: text("enrichment_status").notNull().default("pending"),
  featuresJson: text("features_json"),
  isrc: text("isrc"),
  key: text("key"),
  label: text("label"),
  logId: text("log_id").unique(),
  note: text("note"),
  popularity: integer("popularity"),
  postedToTelegram: integer("posted_to_telegram", { mode: "boolean" }).notNull().default(false),
  postedToTelegramAt: text("posted_to_telegram_at"),
  // Operator-only archive path for the one official 30s preview preserved for
  // private analysis/model training. Never exposed through public DTOs and
  // never used by /api/preview playback.
  previewArchiveKey: text("preview_archive_key"),
  previewArchiveMime: text("preview_archive_mime"),
  previewArchiveSource: text("preview_archive_source"),
  previewArchivedAt: text("preview_archived_at"),
  previewUrl: text("preview_url"),
  releaseDate: text("release_date"),
  spotifyError: text("spotify_error"),
  spotifyUri: text("spotify_uri").notNull(),
  spotifyUrl: text("spotify_url").notNull(),
  telegramError: text("telegram_error"),
  title: text("title").notNull(),
  trackId: text("track_id").primaryKey(),
  // Last content change to the finding's record: every write path (publish,
  // curation/enrichment update, social-post state) bumps it. Null for rows that
  // predate the column; readers fall back to added_at (sitemap lastmod).
  updatedAt: text("updated_at"),
  // The finding's place in vibe-space (the admin tagging map; see
  // docs/admin-tagging.md): vibeX = Light(-1)↔Dark(+1) mood, vibeY =
  // Floaty(-1)↔Driving(+1) energy, each roughly -1..1. The quadrant is the
  // finding's galaxy (Solar/Nebular/Lunar/Deep). Null = not yet placed; the
  // operator drops it on the map. Replaces sub-genre tags as the grouping.
  vibeX: real("vibe_x"),
  vibeY: real("vibe_y"),
  // The AI model that authored the track's video, in <provider>/<model> notation
  // (e.g. "anthropic/claude-opus-4-8"). Set when the video is uploaded; surfaced
  // in /api/tracks alongside the vehicle. Defaults so existing rows backfill.
  videoModel: text("video_model").default("anthropic/claude-opus-4-8"),
  // The reasoning/thinking effort the authoring model ran at (e.g. "high",
  // "medium", "low"). Set when the video is uploaded; surfaced in /api/tracks so
  // we can compare model × thinking level. Defaults to "high" — the existing
  // videos were authored at high reasoning, so existing rows backfill.
  videoModelReasoning: text("video_model_reasoning").default("high"),
  videoUrl: text("video_url"),
  // The travelling vehicle of the track's video (e.g. "voronoi cellular",
  // "caustic web"). Set when the video is uploaded; surfaced in /api/tracks so
  // the next (ephemeral) video agent can read recent vehicles and diversify.
  videoVehicle: text("video_vehicle"),
});

export const spotifyAuth = sqliteTable("spotify_auth", {
  accessToken: text("access_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  refreshToken: text("refresh_token").notNull(),
  scope: text("scope").notNull(),
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

export const userSavedFindings = sqliteTable(
  "user_saved_findings",
  {
    id: text("id").primaryKey(),
    logId: text("log_id").notNull(),
    note: text("note"),
    savedAt: text("saved_at").notNull(),
    trackId: text("track_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [uniqueIndex("user_saved_findings_user_track_idx").on(table.userId, table.trackId)],
);

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

// Per-platform publication state for a track's video. One row per (track,
// platform); the generic track pipeline tops out at "video in R2" (video_url),
// and publication is tracked here. Today: TikTok via Postiz (push draft → manual
// review/publish in-app → status updated by the operator). Extensible to
// YouTube Shorts / Instagram Reels (the `platform` enum widens — plain TEXT, no
// migration). `external_id` holds the Postiz post id; `url` the public post URL.
export const socialPosts = sqliteTable(
  "social_posts",
  {
    createdAt: text("created_at").notNull(),
    externalId: text("external_id"),
    id: text("id").primaryKey(),
    platform: text("platform", { enum: ["tiktok"] }).notNull(),
    publishedAt: text("published_at"),
    scheduledFor: text("scheduled_for"),
    status: text("status", { enum: ["draft", "scheduled", "published", "failed"] }).notNull(),
    trackId: text("track_id").notNull(),
    updatedAt: text("updated_at").notNull(),
    url: text("url"),
  },
  (table) => [uniqueIndex("social_posts_track_platform_idx").on(table.trackId, table.platform)],
);

export const mixtapes = sqliteTable("mixtapes", {
  addedAt: text("added_at"),
  coverImageUrl: text("cover_image_url"),
  createdAt: text("created_at").notNull(),
  durationMs: integer("duration_ms"),
  id: text("id").primaryKey(),
  logId: text("log_id").unique(),
  mixcloudUrl: text("mixcloud_url"),
  note: text("note"),
  publishedAt: text("published_at"),
  recordedAt: text("recorded_at"),
  sequenceNumber: integer("sequence_number").unique(),
  soundcloudUrl: text("soundcloud_url"),
  status: text("status", { enum: ["draft", "published"] })
    .notNull()
    .default("draft"),
  title: text("title").notNull(),
  updatedAt: text("updated_at").notNull(),
  youtubeUrl: text("youtube_url"),
});

export const mixtapeTracks = sqliteTable(
  "mixtape_tracks",
  {
    mixtapeId: text("mixtape_id").notNull(),
    position: integer("position").notNull(),
    trackId: text("track_id").notNull(),
  },
  (table) => [
    index("mixtape_tracks_mixtape_id_idx").on(table.mixtapeId),
    uniqueIndex("mixtape_tracks_mixtape_position_idx").on(table.mixtapeId, table.position),
    uniqueIndex("mixtape_tracks_mixtape_track_idx").on(table.mixtapeId, table.trackId),
  ],
);
