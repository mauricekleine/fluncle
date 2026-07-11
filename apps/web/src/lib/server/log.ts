type LogLevel = "error" | "info" | "warn";

/**
 * The Worker's one structured-log emitter. Every server-side `console.warn` /
 * `console.error` goes through here so a failed enrich/publish is traceable by a
 * single stable field (`event`) plus correlation ids, instead of a grab-bag of
 * hand-rolled prefixes only a `grep` archaeologist can follow.
 *
 * It emits exactly ONE JSON object per line via the matching `console[level]` —
 * that line is what `wrangler tail` and the Cloudflare dashboard show, and one
 * object per line is the greppable contract (`event:"publish.telegram-failed"`).
 * `Error` values in `fields` are serialized to `{ message, stack }` (a bare
 * `Error` JSON-stringifies to `{}`, dropping the only copy of the fault detail).
 * No timestamp — the platform stamps every log line, so adding one here is noise.
 */
export function logEvent(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  const payload: Record<string, unknown> = { event };

  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      payload[key] =
        value instanceof Error ? { message: value.message, stack: value.stack } : value;
    }
  }

  // The single JSON line. `console[level]` picks warn vs error so log-level
  // filtering in the CF dashboard still works.
  console[level](JSON.stringify(payload));
}
