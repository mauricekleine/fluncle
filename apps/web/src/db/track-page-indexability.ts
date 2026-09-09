/** The original exact predicate index stays available for schema compatibility. */
export const TRACK_PAGE_INDEXABLE_LEGACY_COUNT_INDEX = "tracks_sitemap_indexable_track_id_idx";

/** The forced count's covering index behind a simple catalogue partial predicate. */
export const TRACK_PAGE_INDEXABLE_COVER_COUNT_INDEX = "tracks_sitemap_indexable_cover_idx";

export type TrackPageIndexableDestination = "spotify" | "appleOnly";

function column(table: string | undefined, name: string): string {
  return table === undefined ? name : `${table}.${name}`;
}

/**
 * The archive-track evidence gate in SQL. Runtime consumers pass their relation alias; the schema
 * uses the unqualified form required by SQLite partial-index DDL.
 */
export function trackPageIdentityWhere(table?: string): string {
  return `trim(${column(table, "title")}) <> ''
      and ${column(table, "artists_json")} is not null and trim(${column(table, "artists_json")}) not in ('', '[]')
      and ${column(table, "dismissed_at")} is null`;
}

/** The exact, disjoint destination partition used by the two count branches. */
export function trackPageIndexableDestinationWhere(
  destination: TrackPageIndexableDestination,
  table?: string,
): string {
  if (destination === "spotify") {
    return `${column(table, "spotify_url")} is not null`;
  }

  return `${column(table, "spotify_url")} is null and ${column(table, "apple_music_url")} is not null`;
}

/** The simple catalogue partial predicate for the count's covering index. */
export function trackPageIndexableCoverIndexWhere(table?: string): string {
  return `${column(table, "is_catalogue")} = 1`;
}

/** The one evidence gate shared by the page, sitemap membership, and count-only partial index. */
export function trackPageIndexableWhere(table?: string): string {
  return `${column(table, "is_catalogue")} = 1
      and ${column(table, "duplicate_of_track_id")} is null
      and ${trackPageIdentityWhere(table)}
      and ${column(table, "album_id")} is not null
      and ${column(table, "release_date")} is not null
      and ${column(table, "album_image_url")} is not null
      and (${column(table, "spotify_url")} is not null or ${column(table, "apple_music_url")} is not null)`;
}

/** The full evidence gate plus one destination partition — exact membership for each count branch. */
export function trackPageIndexableCountQueryWhere(
  destination: TrackPageIndexableDestination,
  table?: string,
): string {
  return `${trackPageIndexableWhere(table)}
      and ${trackPageIndexableDestinationWhere(destination, table)}`;
}
