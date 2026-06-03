import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tracks = sqliteTable("tracks", {
  trackId: text("track_id").primaryKey(),
  spotifyUrl: text("spotify_url").notNull(),
  spotifyUri: text("spotify_uri").notNull(),
  title: text("title").notNull(),
  artistsJson: text("artists_json").notNull(),
  album: text("album"),
  durationMs: integer("duration_ms").notNull(),
  note: text("note"),
  addedAt: text("added_at").notNull(),
  addedToSpotify: integer("added_to_spotify", { mode: "boolean" }).notNull().default(false),
  addedToSpotifyAt: text("added_to_spotify_at"),
  spotifyError: text("spotify_error"),
  postedToTelegram: integer("posted_to_telegram", { mode: "boolean" }).notNull().default(false),
  postedToTelegramAt: text("posted_to_telegram_at"),
  telegramError: text("telegram_error"),
});

export const spotifyAuth = sqliteTable("spotify_auth", {
  service: text("service").primaryKey(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  scope: text("scope").notNull(),
  updatedAt: text("updated_at").notNull(),
});
