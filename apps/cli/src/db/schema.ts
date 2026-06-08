import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tracks = sqliteTable("tracks", {
  addedAt: text("added_at").notNull(),
  addedToSpotify: integer("added_to_spotify", { mode: "boolean" }).notNull().default(false),
  addedToSpotifyAt: text("added_to_spotify_at"),
  album: text("album"),
  albumImageUrl: text("album_image_url"),
  artistsJson: text("artists_json").notNull(),
  durationMs: integer("duration_ms").notNull(),
  isrc: text("isrc"),
  label: text("label"),
  logId: text("log_id").unique(),
  note: text("note"),
  popularity: integer("popularity"),
  postedToTelegram: integer("posted_to_telegram", { mode: "boolean" }).notNull().default(false),
  postedToTelegramAt: text("posted_to_telegram_at"),
  previewUrl: text("preview_url"),
  spotifyError: text("spotify_error"),
  spotifyUri: text("spotify_uri").notNull(),
  spotifyUrl: text("spotify_url").notNull(),
  tagsJson: text("tags_json"),
  telegramError: text("telegram_error"),
  title: text("title").notNull(),
  trackId: text("track_id").primaryKey(),
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
