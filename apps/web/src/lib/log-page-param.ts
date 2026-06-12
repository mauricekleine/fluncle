import { isLogId } from "./log-id";

// A legacy deep-link form: the 22-char base-62 Spotify track id (the /log
// loader 301s it to the finding's coordinate).
const SPOTIFY_TRACK_ID_PATTERN = /^[0-9A-Za-z]{22}$/;

/**
 * The /log/$logId shape guard: a param is either a Log ID coordinate or a
 * Spotify track id; anything else 404s before the loader ever runs.
 */
export function isLogPageParam(value: string): boolean {
  return isLogId(value) || SPOTIFY_TRACK_ID_PATTERN.test(value);
}
