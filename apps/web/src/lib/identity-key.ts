// The identity KEY grammar — the three shapes a caller may look a recording up by, and how each
// normalizes to the spelling Fluncle stores.
//
// CLIENT-SAFE BY CONSTRUCTION: pure string work, no imports, no database. That is the whole reason
// it is its own module rather than living beside the envelope. `lib/server/identity-envelope.ts`
// re-exports the two normalizers so the server keeps one entrypoint, while `/identity`'s route can
// canonicalize a submitted key inside `loader` — which is eagerly bundled — without welding the
// `getDb` → `@libsql/client` chain onto every page's first paint (docs/client-bundle.md rule 1,
// the `lib/catalogue.ts` / `lib/galaxies.ts` shape).

/** ISRC canonical form: two-letter country, three-character registrant, five digits of year+serial. */
const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/** MusicBrainz ids are UUIDs. Stored bare (no `mb_` prefix) — the PK carries that, the column does not. */
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Normalize a caller's ISRC to the form the column stores, or `undefined` when it is not an ISRC at
 * all. Hyphens and spaces are the common human spelling (`GB-ABC-12-34567`) and are stripped; the
 * result is upper-cased so the lookup can be a bare `isrc = ?` equality that rides `tracks_isrc_idx`
 * (wrapping the column in `upper()` would forfeit the index over a growing table).
 */
export function normalizeIsrcKey(raw: string): string | undefined {
  const compact = raw.replace(/[\s-]/g, "").toUpperCase();

  return ISRC_PATTERN.test(compact) ? compact : undefined;
}

/** Normalize a caller's MusicBrainz recording id, or `undefined` when it is not a UUID. */
export function normalizeMbidKey(raw: string): string | undefined {
  const compact = raw.trim().toLowerCase().replace(/^mb_/, "");

  return MBID_PATTERN.test(compact) ? compact : undefined;
}

/**
 * The one spelling of a key that gets a page: an ISRC upper-cased and unhyphenated, a MusicBrainz id
 * lower-cased and unprefixed, anything else trimmed and left alone (a Log ID or a track id is stored
 * exactly as it reads).
 *
 * This is what keeps one recording from being reachable at a dozen addresses. The lookup form
 * redirects onto it, and the answer page canonicalizes onto it, so a citation converges on one URL
 * however the reader typed the key.
 */
export function canonicalIdentityKey(raw: string): string {
  return normalizeIsrcKey(raw) ?? normalizeMbidKey(raw) ?? raw.trim();
}
