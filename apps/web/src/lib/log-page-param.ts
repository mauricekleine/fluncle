import { isLogId, isMixtapeLogId } from "./log-id";

// A legacy deep-link form: the 22-char base-62 Spotify track id (the /log
// loader 301s it to the finding's coordinate).
const SPOTIFY_TRACK_ID_PATTERN = /^[0-9A-Za-z]{22}$/;

/**
 * The /log/$logId shape guard: a param is either a Log ID coordinate or a
 * Spotify track id; anything else 404s before the loader ever runs.
 */
export function isLogPageParam(value: string): boolean {
  return isLogId(value) || isMixtapeLogId(value) || SPOTIFY_TRACK_ID_PATTERN.test(value);
}

/**
 * The bare-coordinate resolver's guard (`fluncle.com/049.7.6B` → `/log/049.7.6B`):
 * a viewer types the coordinate they read off a video frame, so match the finding +
 * mixtape grammar CASE-INSENSITIVELY by uppercasing first, then validating. Returns
 * the canonical (uppercased) coordinate when it matches, else undefined.
 *
 * The Spotify track-id deep-link form `isLogPageParam` also accepts is deliberately
 * NOT matched here: a bare 22-char base-62 id is not something a viewer reads off a
 * frame, and uppercasing would corrupt its case-sensitive alphabet. Only the two
 * coordinate shapes resolve at the root; everything else falls through to the 404.
 */
export function canonicalCoordinate(value: string): string | undefined {
  const upper = value.toUpperCase();

  return isLogId(upper) || isMixtapeLogId(upper) ? upper : undefined;
}
