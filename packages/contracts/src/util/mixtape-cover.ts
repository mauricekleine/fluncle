/**
 * The renditions served by the on-the-fly mixtape cover endpoint. `square`, `og`, and `wide`
 * serve distribution and link previews; `card` and `thumb` right-size on-site cover slots.
 */
export type MixtapeCoverSize = "card" | "og" | "square" | "thumb" | "wide";

/**
 * Raise this cache key whenever the shared cover background or stamp layout changes. Covers are
 * immutable for one year, so every surface must use the same version after a re-bake.
 */
export const MIXTAPE_COVER_VERSION = 2;

/** Build a versioned URL for a published mixtape's derived cover. */
export function buildMixtapeCoverUrl(
  baseUrl: string,
  logId: string,
  size: MixtapeCoverSize = "square",
): string {
  return `${baseUrl}/api/mixtape-cover/${encodeURIComponent(logId)}?size=${size}&v=${MIXTAPE_COVER_VERSION}`;
}
