/** The count index, its runtime lock, and the synthetic fixture must use one predicate. */
export const TRACK_PAGE_INDEXABLE_COUNT_INDEX = "tracks_sitemap_indexable_track_id_idx";

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
