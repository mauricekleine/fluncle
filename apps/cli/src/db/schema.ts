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
  previewUrl: text("preview_url"),
  releaseDate: text("release_date"),
  spotifyError: text("spotify_error"),
  spotifyUri: text("spotify_uri").notNull(),
  spotifyUrl: text("spotify_url").notNull(),
  tagsJson: text("tags_json"),
  tagsSource: text("tags_source"),
  telegramError: text("telegram_error"),
  title: text("title").notNull(),
  trackId: text("track_id").primaryKey(),
  videoUrl: text("video_url"),
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
    source: text("source", { enum: ["web", "cli"] }).notNull(),
    spotifyTrackId: text("spotify_track_id").notNull(),
    spotifyUrl: text("spotify_url").notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull(),
    submitterHash: text("submitter_hash").notNull(),
    title: text("title").notNull(),
  },
  (table) => [
    index("submissions_status_created_at_idx").on(table.status, table.createdAt),
    index("submissions_spotify_track_id_idx").on(table.spotifyTrackId),
    index("submissions_submitter_hash_created_at_idx").on(table.submitterHash, table.createdAt),
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
