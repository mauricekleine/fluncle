// The identity KEY grammar — the shapes a caller may look a recording up by, and how each
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

// ── THE PLATFORM-URL KEYS ────────────────────────────────────────────────────────────────────
// A caller arriving from a dead link resolver holds a platform URL, not an identifier: a Spotify
// link off a share sheet, a Deezer link out of a playlist. Those are keys too, and the grammar for
// them lives here beside the other two so the page and the op parse one URL identically.
//
// Both ids are checked against their platform's own documented shape rather than accepted loosely.
// That is deliberate: a strict pattern turns a typo into a 422 that names the problem, where a
// tolerant one would turn it into a 404 that says the archive holds nothing — the wrong answer to
// the wrong question, and the harder one to debug from the outside.

/** Spotify track ids are 22 characters of base62. */
const SPOTIFY_ID_PATTERN = /^[A-Za-z0-9]{22}$/;

/** Deezer track ids are decimal integers. Bounded so a pathological string cannot become a key. */
const DEEZER_ID_PATTERN = /^\d{1,20}$/;

/** The `spotify:track:<id>` URI form, as the share sheet and the desktop client hand it out. */
const SPOTIFY_URI_PATTERN = /^spotify:track:([A-Za-z0-9]+)$/i;

/** The mirrored Deezer spelling `canonicalIdentityKey` emits (see {@link platformIdentityKey}). */
const DEEZER_URI_PATTERN = /^deezer:track:(\d+)$/i;

/**
 * Pull the id out of a platform track URL: the path segment after `track`.
 *
 * Tolerant of everything a real pasted link carries and nothing else. The scheme may be missing
 * (`deezer.com/track/3135556`), the host may be any subdomain of the platform's (`open.`, `www.`,
 * bare), a locale segment may sit in front of `track` (`/nl/track/…`, `/intl-de/track/…`), and any
 * query string or fragment is dropped (`?si=…`, `?utm_source=…`). The HOST is checked, so a link to
 * somewhere else that happens to have a `/track/` path is not read as a key.
 */
function trackIdFromUrl(raw: string, host: string): string | undefined {
  // `new URL` needs a scheme; a pasted link often has none. Only prefix when there is no scheme at
  // all, so `spotify:track:…` is never mangled into a bogus https URL.
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;

  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }

  const hostname = url.hostname.toLowerCase();

  if (hostname !== host && !hostname.endsWith(`.${host}`)) {
    return undefined;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const at = segments.indexOf("track");

  return at === -1 ? undefined : segments[at + 1];
}

/**
 * Normalize a caller's Spotify key to the bare track id, or `undefined` when it is not one.
 *
 * Accepts the three spellings that exist in the wild: a full `open.spotify.com/track/<id>` URL
 * (locale segment and `?si=` tracking and all), the `spotify:track:<id>` URI, and the bare id.
 */
export function normalizeSpotifyKey(raw: string): string | undefined {
  const trimmed = raw.trim();
  const uri = SPOTIFY_URI_PATTERN.exec(trimmed);
  const candidate = uri?.[1] ?? trackIdFromUrl(trimmed, "spotify.com") ?? trimmed;

  return SPOTIFY_ID_PATTERN.test(candidate) ? candidate : undefined;
}

/**
 * Normalize a caller's Deezer key to the bare track id, or `undefined` when it is not one.
 *
 * Accepts a full `deezer.com/track/<id>` URL (locale segment and tracking parameters and all), the
 * mirrored `deezer:track:<id>` spelling, and the bare id.
 */
export function normalizeDeezerKey(raw: string): string | undefined {
  const trimmed = raw.trim();
  const uri = DEEZER_URI_PATTERN.exec(trimmed);
  const candidate = uri?.[1] ?? trackIdFromUrl(trimmed, "deezer.com") ?? trimmed;

  return DEEZER_ID_PATTERN.test(candidate) ? candidate : undefined;
}

/** A key that named its own platform: the id, and which platform it belongs to. */
export type PlatformIdentityKey = { id: string; platform: "deezer" | "spotify" };

/**
 * Read a key that NAMES ITS OWN PLATFORM — a link or a URI, never a bare id.
 *
 * The bare-id exclusion is the whole point. On the API a caller spells the platform out in the
 * query key (`?spotify=`), so a bare id there is unambiguous. On the page there is one field and one
 * path segment, and a bare Spotify id is indistinguishable from Fluncle's own track id for a
 * finding (they are the same string — a published finding's row is keyed by its Spotify id). So the
 * page reads only the forms that say which platform they are, and a bare string stays what it has
 * always been: a Log ID or a track id.
 */
export function platformIdentityKey(raw: string): PlatformIdentityKey | undefined {
  const trimmed = raw.trim();
  const spotifyUri = SPOTIFY_URI_PATTERN.exec(trimmed)?.[1];

  if (spotifyUri && SPOTIFY_ID_PATTERN.test(spotifyUri)) {
    return { id: spotifyUri, platform: "spotify" };
  }

  const deezerUri = DEEZER_URI_PATTERN.exec(trimmed)?.[1];

  if (deezerUri && DEEZER_ID_PATTERN.test(deezerUri)) {
    return { id: deezerUri, platform: "deezer" };
  }

  const spotifyUrl = trackIdFromUrl(trimmed, "spotify.com");

  if (spotifyUrl && SPOTIFY_ID_PATTERN.test(spotifyUrl)) {
    return { id: spotifyUrl, platform: "spotify" };
  }

  const deezerUrl = trackIdFromUrl(trimmed, "deezer.com");

  if (deezerUrl && DEEZER_ID_PATTERN.test(deezerUrl)) {
    return { id: deezerUrl, platform: "deezer" };
  }

  return undefined;
}

/**
 * The one spelling of a key that gets a page: an ISRC upper-cased and unhyphenated, a MusicBrainz id
 * lower-cased and unprefixed, a pasted platform link collapsed to `<platform>:track:<id>`, anything
 * else trimmed and left alone (a Log ID or a track id is stored exactly as it reads).
 *
 * This is what keeps one recording from being reachable at a dozen addresses. The lookup form
 * redirects onto it, and the answer page canonicalizes onto it, so a citation converges on one URL
 * however the reader typed the key. A link is the strongest case for it: the same Spotify track is
 * pasted with a locale segment, with a `?si=` tag, and as a URI, and all three land on one address.
 */
export function canonicalIdentityKey(raw: string): string {
  const platform = platformIdentityKey(raw);

  return (
    normalizeIsrcKey(raw) ??
    normalizeMbidKey(raw) ??
    (platform ? `${platform.platform}:track:${platform.id}` : raw.trim())
  );
}
