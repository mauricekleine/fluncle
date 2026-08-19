/**
 * The device database's complete column allowlist.
 *
 * This mapping is a security boundary: a mobile device connects directly to the derived
 * public-catalogue database, so a source column ships only when it is named here. Keep source-only
 * selection inputs (most importantly the MuQ vector) out even when a cut predicate reads them —
 * and the vector's own table, `track_embeddings`, is absent from this map entirely.
 */
export const DEVICE_DB_COLUMNS = {
  albums: [
    "id",
    "name",
    "slug",
    "apple_album_id",
    "artwork_bg_color",
    "artwork_height",
    "artwork_text_color1",
    "artwork_text_color2",
    "artwork_text_color3",
    "artwork_text_color4",
    "artwork_url_template",
    "artwork_width",
    "bio",
    "certified_finding_count",
    "created_at",
    "record_label_raw",
    "release_group_mbid",
    "renderable_track_count",
    "upc",
    "updated_at",
  ],
  artists: [
    "id",
    "name",
    "slug",
    "bio",
    "certified_finding_count",
    "created_at",
    "discogs_url",
    "image_url",
    "lastfm_url",
    "mbid",
    "renderable_track_count",
    "spotify_artist_id",
    "spotify_url",
    "updated_at",
    "wikidata_qid",
  ],
  findings: [
    "track_id",
    "log_id",
    "added_at",
    "updated_at",
    "note",
    "observation_alignment_json",
    "observation_audio_url",
    "observation_duration_ms",
    "observation_generated_at",
    "video_grain",
    "video_model",
    "video_model_reasoning",
    "video_palette",
    "video_plate_subject",
    "video_register",
    "video_squared_at",
    "video_structure",
    "video_url",
    "video_vehicle",
  ],
  labels: [
    "id",
    "name",
    "slug",
    "bio",
    "certified_finding_count",
    "created_at",
    "discogs_label_id",
    "founded_location",
    "founding_date",
    "mb_label_id",
    "parent_label_id",
    "renderable_track_count",
    "updated_at",
  ],
  track_artists: ["track_id", "artist_id", "position", "role"],
  tracks: [
    "track_id",
    "spotify_url",
    "spotify_uri",
    "title",
    "artists_json",
    "album",
    "album_id",
    "album_image_url",
    "apple_music_url",
    "bpm",
    "duration_ms",
    "in_master_id",
    "in_release_id",
    "is_catalogue",
    "isrc",
    "key",
    "label",
    "label_id",
    "mb_recording_id",
    "popularity",
    "preview_url",
    "release_date",
  ],
} as const;

export type DeviceSourceTable = keyof typeof DEVICE_DB_COLUMNS;

export const DEVICE_SOURCE_TABLES = [
  "tracks",
  "findings",
  "artists",
  "labels",
  "albums",
  "track_artists",
] as const satisfies readonly DeviceSourceTable[];

export const DEVICE_SYNC_META_COLUMNS = [
  "schema_version",
  "cut_name",
  "derived_at",
  "source_watermark",
] as const;

export const DEVICE_DB_SCHEMA_VERSION = 1;

/**
 * Column-name patterns that can never cross the device boundary. The storage-key expression
 * deliberately permits the musical `tracks.key` while rejecting names such as `image_key`,
 * `source_audio_key`, and `preview_archive_key`.
 */
export const BANNED_DEVICE_COLUMN_PATTERNS = [
  { name: "embedding", pattern: /embedding/i },
  { name: "vector", pattern: /vector/i },
  { name: "token", pattern: /token/i },
  { name: "secret", pattern: /secret/i },
  { name: "email", pattern: /email/i },
  {
    name: "storage key",
    pattern: /(?:^|_)(?:archive|audio|capture|image|object|r2|storage)_key(?:_|$)/i,
  },
] as const;
