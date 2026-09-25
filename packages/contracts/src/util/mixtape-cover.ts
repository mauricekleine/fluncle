export type MixtapeCoverSize = "card" | "og" | "square" | "thumb" | "wide";

export const MIXTAPE_COVER_VERSION = 2;

export function buildMixtapeCoverUrl(
  baseUrl: string,
  logId: string,
  size: MixtapeCoverSize = "square",
): string {
  return `${baseUrl}/api/mixtape-cover/${encodeURIComponent(logId)}?size=${size}&v=${MIXTAPE_COVER_VERSION}`;
}
