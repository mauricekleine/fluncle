// The coordinate is the only thing Fluncle Lens knows how to read off a page: a
// finding's Log ID in its `fluncle://XXX.Y.ZZ` scheme. Everything else — the link,
// the hover card, the popup row, the dig/ssh commands — is derived from it here, so
// there is one place that owns the format and the casing rules.

/**
 * Matches a `fluncle://` coordinate anywhere in a run of text: a 3-or-4-digit sector
 * (it widens to four around 2029-02-22), a dot, then either a track's
 * `digit.digit-letter` (`\d\.\d[A-Z]`) or a mixtape's `F.digit-letter-A-through-F`
 * (`F\.\d[A-F]`). The mark is exactly two characters — a digit then a single letter —
 * so the pattern rejects the malformed run-ons the old `[0-9A-Z]+` over-matched.
 * Case-insensitive and global so a single text node can carry several. The capture
 * group is the bare Log ID (no scheme).
 *
 * The literal `fluncle://` prefix anchors the front; a negative lookahead for
 * `[0-9A-Z]` marks the end so the final segment can't run on into a longer word. A
 * trailing `.` is deliberately allowed past the boundary — the mark never contains a
 * dot, so a `.` after it is sentence punctuation ("…fluncle://007.0.0Z."), not part
 * of the coordinate.
 *
 * CANONICAL HOME: `@fluncle/contracts/log-id` `COORDINATE_PATTERN`. This is a
 * deliberate byte-for-byte COPY — the Lens runtime bundle (built by scripts/build.ts)
 * ships zero workspace dependencies, so it can't import the shared module. A
 * drift-tripwire test (coordinate.test.ts) asserts this source string equals the
 * canonical one, so the two can never diverge silently.
 */
export const COORDINATE_PATTERN = /fluncle:\/\/(\d{3,4}\.(?:\d\.\d[A-Z]|F\.\d[A-F]))(?![0-9A-Z])/gi;

/** A coordinate found in the page: the text exactly as written, plus its bare Log ID. */
export type Coordinate = {
  /** The Log ID exactly as it appeared on the page (casing preserved). */
  id: string;
  /** The full match including the `fluncle://` scheme, as written. */
  raw: string;
};

/** Pulls every distinct coordinate out of a string, preserving display casing. */
export function findCoordinates(text: string): Coordinate[] {
  const found: Coordinate[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(COORDINATE_PATTERN)) {
    const id = match[1];

    if (id && !seen.has(id)) {
      seen.add(id);
      found.push({ id, raw: match[0] });
    }
  }

  return found;
}

/**
 * The finding's permanent log page on fluncle.com. The Log ID is uppercased: the
 * stored `log_id` is canonical-cased (`241.7.3A`) and the `/log/$logId` lookup is
 * case-sensitive, so a lowercase-written coordinate must be normalized to resolve.
 * Only the URL is uppercased — the coordinate stays exactly as written on the page.
 */
export function webUrl(id: string): string {
  return `https://www.fluncle.com/log/${id.toUpperCase()}`;
}

/**
 * The public API read for a single finding by its Log ID. Uppercased for the same
 * reason as `webUrl`: `where log_id = ?` is case-sensitive against the canonical
 * stored casing, so `241.7.3a` would 404 unless normalized first.
 */
export function apiUrl(id: string): string {
  return `https://www.fluncle.com/api/tracks/${id.toUpperCase()}`;
}

/**
 * The DNS lookup for a finding's TXT record. DNS labels are case-insensitive but
 * conventionally lowercase, so the Log ID is lowercased here (and only here) — the
 * displayed coordinate stays exactly as written. e.g. `007.0.0Z` → `007.0.0z`.
 */
export function digCommand(id: string): string {
  return `dig ${id.toLowerCase()}.dig.fluncle.com TXT +short`;
}

/** The rave-terminal lookup for a finding, keyed by the coordinate as written. */
export function sshCommand(id: string): string {
  return `ssh rave.fluncle.com ${id}`;
}

/**
 * Guards an API-provided href before it becomes a link target. The lens trusts the
 * Log ID it detected, not the strings the API returns for it — a `spotifyUrl` or
 * `webUrl` that isn't a plain `https:` URL (e.g. `javascript:`, `data:`, a relative
 * path, or garbage) falls back to the finding's own log page, which is always safe.
 */
export function safeHref(href: string | undefined, id: string): string {
  if (href) {
    try {
      if (new URL(href).protocol === "https:") {
        return href;
      }
    } catch {
      // Not an absolute URL — fall through to the safe log-page default.
    }
  }

  return webUrl(id);
}
