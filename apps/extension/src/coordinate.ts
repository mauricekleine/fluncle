// The coordinate is the only thing Fluncle Lens knows how to read off a page: a
// finding's Log ID in its `fluncle://XXX.Y.ZZ` scheme. Everything else — the link,
// the hover card, the popup row, the dig/ssh commands — is derived from it here, so
// there is one place that owns the format and the casing rules.

/**
 * Matches a `fluncle://` coordinate anywhere in a run of text. Mirrors the brief's
 * shape: three digits, a dot, one digit (or `F` for a mixtape), a dot, then one or
 * more alphanumerics. Case-insensitive and global so a single text node can carry
 * several. The capture group is the bare Log ID (no scheme).
 *
 * The literal `fluncle://` prefix anchors the front; a negative lookahead for
 * `[0-9A-Z]` marks the end so the final segment can't run on into a longer word. A
 * trailing `.` is deliberately allowed past the boundary — the third segment never
 * contains a dot, so a `.` after it is sentence punctuation ("…fluncle://007.0.0Z."),
 * not part of the coordinate.
 */
export const COORDINATE_PATTERN = /fluncle:\/\/([0-9]{3}\.[0-9A-Z]\.[0-9A-Z]+)(?![0-9A-Z])/gi;

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

/** The finding's permanent log page on fluncle.com. */
export function webUrl(id: string): string {
  return `https://www.fluncle.com/log/${id}`;
}

/** The public API read for a single finding by its Log ID. */
export function apiUrl(id: string): string {
  return `https://www.fluncle.com/api/tracks/${id}`;
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
