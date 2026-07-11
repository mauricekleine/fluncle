// The ONE grammar for a Fluncle Log ID coordinate — the `sector.orbit.mark` shape
// (e.g. `004.7.2I`) that names a finding on every surface, and its `.F.` mixtape
// variant (`019.F.1A`). Written down once here so "what counts as a coordinate"
// can't drift between the surfaces that read it:
//   - the web format guards        — apps/web/src/lib/log-id.ts (re-exports these)
//   - the Galaxy star placement    — apps/web/src/game/placement.ts (finding pattern)
//   - the Chrome extension scanner — apps/extension/src/coordinate.ts (keeps a
//     byte-checked COPY: its runtime bundle ships zero workspace deps, so a
//     drift-tripwire test asserts the copy equals this source instead)
//   - the Go SSH resolver          — apps/ssh/main.go (`looksLikeLogID`, a
//     deliberately looser hand-typed pre-filter; can't import TS)
// The shared LOG_ID_TEST_VECTORS below are the cross-surface fixture that pins the
// TS mirrors (and their Go sibling) to this definition.

/**
 * A finding coordinate: `sector.orbit.mark` — a 3-or-4-digit sector (it widens to
 * four around 2029-02-22), a single-digit orbit, then a `\d[A-Z]` mark, e.g.
 * `004.7.2I`. Anchored + case-SENSITIVE: the stored `log_id` is canonical-cased.
 */
export const FINDING_LOG_ID_PATTERN = /^\d{3,4}\.\d\.\d[A-Z]$/;

/**
 * A mixtape coordinate: the same shape with the literal `F` (Fluncle) marker in the
 * middle slot where a finding carries a digit, and a mark confined to `\d[A-F]`
 * (the 1A..9F mixtape-number tail), e.g. `019.F.1A`. Anchored + case-sensitive.
 */
export const MIXTAPE_LOG_ID_PATTERN = /^\d{3,4}\.F\.\d[A-F]$/;

/**
 * Matches a `fluncle://` coordinate anywhere in a run of text — the scheme-scanning
 * form the extension reads off a page. A 3-or-4-digit sector, a dot, then either a
 * finding's `\d\.\d[A-Z]` or a mixtape's `F\.\d[A-F]`. The mark is exactly two
 * characters (a digit then a single letter), so the trailing negative lookahead
 * `(?![0-9A-Z])` stops the final segment running on into a longer word (rejecting the
 * malformed run-ons a greedy `[0-9A-Z]+` over-matched). A trailing `.` past the
 * boundary is allowed — the mark never contains a dot, so it reads as sentence
 * punctuation. Case-INSENSITIVE + global so one text node can carry several and the
 * page's display casing is preserved; the capture group is the bare Log ID (no scheme).
 */
export const COORDINATE_PATTERN = /fluncle:\/\/(\d{3,4}\.(?:\d\.\d[A-Z]|F\.\d[A-F]))(?![0-9A-Z])/gi;

/** Whether a string is a well-formed finding Log ID (bare form, no scheme). */
export function isLogId(value: string): boolean {
  return FINDING_LOG_ID_PATTERN.test(value);
}

/** Whether a string is a well-formed mixtape coordinate (`sector.F.number`). */
export function isMixtapeLogId(value: string): boolean {
  return MIXTAPE_LOG_ID_PATTERN.test(value);
}

/**
 * The cross-surface fixture for the grammar above. Every TS mirror (and the Go
 * `looksLikeLogID` sibling test) checks itself against these, so a change to the
 * shape has to update the fixture — and every surface's test moves with it.
 */
export const LOG_ID_TEST_VECTORS = {
  /**
   * Lowercase of a canonical id: rejected by the case-SENSITIVE bare guards
   * (`isLogId`/`isMixtapeLogId`), but the case-INSENSITIVE scheme scanner still finds
   * it — the extension preserves display casing and normalizes downstream.
   */
  lowercase: ["241.7.3a", "019.f.1a"],
  /** Structurally malformed: rejected by every surface — the bare guards and the scanner alike. */
  malformed: [
    "04.7.2I", // 2-digit sector (under the 3-digit floor)
    "10240.7.3I", // 5-digit sector (over the 4-digit ceiling)
    "019.G.1A", // wrong marker (a letter that isn't the mixtape `F`)
    "019.F.1Z", // mixtape mark outside A–F
    "007.12.3I", // two-digit orbit (the orbit is one digit)
    "7.0.0Z", // too few sector digits
  ],
  /** Well-formed finding coordinates. */
  validFindings: ["004.7.2I", "241.7.3A", "018.8.9J", "1024.7.3I"],
  /** Well-formed mixtape coordinates (the `.F.` middle slot, mark in A–F). */
  validMixtapes: ["019.F.1A", "019.F.1F", "1024.F.2C"],
} as const;
