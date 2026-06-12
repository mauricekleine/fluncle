// The Log ID surface format — client-safe (the generator lives in
// lib/server/log-id.ts). One regex, shared by the /log/$logId route guard and
// the admin backfill validation, so "what counts as a coordinate" is written
// down once: `sector.orbit.mark`, e.g. "004.7.2I" (sector widens to 4 digits
// around 2029-02-22).
const LOG_ID_PATTERN = /^\d{3,4}\.\d\.\d[A-Z]$/;

/** Whether a string is a well-formed Log ID coordinate (bare form, no scheme). */
export function isLogId(value: string): boolean {
  return LOG_ID_PATTERN.test(value);
}
