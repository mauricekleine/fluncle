// Worker-safe (HTTP + WebCrypto only) Apple Music resolve side: turn a finding's
// ISRC into its Apple Music track URL, EXACTLY, via the Apple Music API's
// `filter[isrc]` catalogue lookup.
//
// WHY THE APPLE MUSIC API AND NOT THE KEYLESS iTUNES SEARCH API. The free, keyless
// iTunes Search API (`itunes.apple.com/lookup`) has NO ISRC lookup — that capability
// lives only on the Apple Music API (`api.music.apple.com`, `filter[isrc]`), which
// requires an authenticated developer token. The keyless API can only fuzzy-match on
// artist + title, and its results carry no ISRC to confirm the match; a fuzzy match is
// unsafe for a link we render publicly on `/log` and stamp into JSON-LD `sameAs` (a
// DnB title like "Loading" returns a wholly different song as the top hit; an
// original vs a remaster differ by a second). Fluncle's rule is exact-or-nothing: a
// missing Apple Music link is honest, a wrong one is not. So this resolve is
// ISRC-exact, and stores a URL ONLY on a byte-certain ISRC match.
//
// THE DEVELOPER TOKEN. The Apple Music API authenticates with a short-lived ES256 JWT
// signed by a MusicKit private key. Three Worker secrets carry the key parts:
// APPLE_MUSIC_TEAM_ID (iss), APPLE_MUSIC_KEY_ID (the `kid` header), and
// APPLE_MUSIC_PRIVATE_KEY (the ES256 .p8 PEM). The Worker mints + caches the JWT with
// WebCrypto; the agent box never holds any of them.
//
// NO-OP UNTIL CONFIGURED. When any of the three secrets is unset the resolve is a
// silent no-op (`{ configured: false }`) — exactly the Last.fm / Bluesky discipline —
// so the whole ecosystem (schema, backfill, CLI, box cron, the web listen link, the
// mobile button, the `sameAs`) ships DARK and lights up the moment the operator
// provisions a MusicKit key. Nothing is ever stored while unconfigured.

import { readOptionalEnv } from "./env";
import { logEvent } from "./log";

// The Apple Music catalogue songs endpoint. The `us` storefront is a sensible default
// — the returned `music.apple.com/us/…` URL geo-redirects to the visitor's own
// storefront when they open it, so the stored value is effectively region-neutral.
const CATALOG_SONGS_URL = "https://api.music.apple.com/v1/catalog/us/songs";
const USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

// The developer-token lifetime. Apple caps a MusicKit token at 6 months; we mint for
// ~150 days and re-mint when within a day of expiry, so a long-running Worker reuses
// one token across many resolves instead of signing on every call.
const TOKEN_TTL_SECONDS = 150 * 24 * 60 * 60;
const TOKEN_REFRESH_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * The outcome of one ISRC resolve.
 *   - `{ configured: false }` — a secret is unset; the leg is a silent no-op. The
 *     caller must NOT record an attempt (the finding stays eligible for when the key
 *     is provisioned).
 *   - `{ configured: true, ok: true, url }` — the API answered; `url` is the exact
 *     match's Apple Music URL, or `null` when Apple has no song for this ISRC yet.
 *   - `{ configured: true, ok: false, rateLimited, error }` — the call failed;
 *     `rateLimited` (an HTTP 429) tells the paced backfill to back off hard.
 */
export type AppleMusicLookupOutcome =
  | { configured: false }
  | { configured: true; ok: true; url: string | null }
  | { authFailed?: boolean; configured: true; error: string; ok: false; rateLimited: boolean };

// The three key parts, read together so "any missing ⇒ unconfigured no-op" is one check.
type AppleMusicCredentials = {
  keyId: string;
  privateKeyPem: string;
  teamId: string;
};

async function readAppleMusicCredentials(): Promise<AppleMusicCredentials | undefined> {
  const [teamId, keyId, privateKeyPem] = await Promise.all([
    readOptionalEnv("APPLE_MUSIC_TEAM_ID"),
    readOptionalEnv("APPLE_MUSIC_KEY_ID"),
    readOptionalEnv("APPLE_MUSIC_PRIVATE_KEY"),
  ]);

  if (!teamId || !keyId || !privateKeyPem) {
    return undefined;
  }

  return { keyId, privateKeyPem, teamId };
}

// ── The ES256 developer token ─────────────────────────────────────────────────

// UTF-8 bytes of a string, freshly allocated so the result is `Uint8Array<ArrayBuffer>`
// (WebCrypto's `BufferSource` params reject the `ArrayBufferLike`-backed view TextEncoder
// returns under the current lib types).
function utf8Bytes(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(value));
}

// base64url of a UTF-8 string (the JWT header + payload segments).
function base64UrlFromString(value: string): string {
  return base64UrlFromBytes(utf8Bytes(value));
}

// base64url of raw bytes (the signature) — standard base64, then URL-safe + unpadded.
function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Decode a PKCS#8 PEM (`.p8`) into the DER bytes WebCrypto's importKey wants. Tolerates
// a key stored with escaped `\n` (the common single-line env-var form).
function pkcs8DerFromPem(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");

  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

/**
 * Build (and ES256-sign) an Apple Music developer JWT from the MusicKit key parts.
 * Exported for unit tests — this is the load-bearing, easy-to-get-wrong bit (the same
 * discipline `signLastfmParams` follows). `nowSeconds` is injectable so a test can pin
 * `iat`/`exp`. WebCrypto's ECDSA/P-256 signature is already the raw r‖s (IEEE P1363)
 * form JWS ES256 requires, so no DER re-encoding is needed.
 */
export async function buildAppleMusicJwt(
  credentials: AppleMusicCredentials,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = { alg: "ES256", kid: credentials.keyId, typ: "JWT" };
  const payload = { exp: nowSeconds + TOKEN_TTL_SECONDS, iat: nowSeconds, iss: credentials.teamId };

  const signingInput = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(
    JSON.stringify(payload),
  )}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8DerFromPem(credentials.privateKeyPem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    { hash: "SHA-256", name: "ECDSA" },
    key,
    utf8Bytes(signingInput),
  );

  return `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

// The minted token, cached across resolves until it nears expiry. Keyed by the KEY_ID
// so a mid-run key rotation re-mints instead of serving a stale token.
let cachedToken: { expiresAtMs: number; keyId: string; token: string } | undefined;

async function developerToken(credentials: AppleMusicCredentials): Promise<string> {
  const now = Date.now();

  if (
    cachedToken &&
    cachedToken.keyId === credentials.keyId &&
    cachedToken.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now
  ) {
    return cachedToken.token;
  }

  const nowSeconds = Math.floor(now / 1000);
  const token = await buildAppleMusicJwt(credentials, nowSeconds);

  cachedToken = {
    expiresAtMs: (nowSeconds + TOKEN_TTL_SECONDS) * 1000,
    keyId: credentials.keyId,
    token,
  };

  return token;
}

// ── The lookup ────────────────────────────────────────────────────────────────

// The minimal shape we read off the Apple Music `songs` response: the first datum's
// share URL.
type AppleMusicSongsResponse = {
  data?: Array<{ attributes?: { url?: string } }>;
};

/**
 * Pull the Apple Music track URL from a catalogue-songs response, or null when the
 * ISRC matched nothing (`data: []`). Exported for unit tests against a fixture body.
 * One ISRC can match more than one pressing; the first is Apple's own primary, and any
 * of them geo-redirects to the same recording — so the first is the honest choice.
 */
export function extractAppleMusicUrl(body: unknown): string | null {
  const url = (body as AppleMusicSongsResponse | null | undefined)?.data?.[0]?.attributes?.url;

  return typeof url === "string" && url.trim() ? url.trim() : null;
}

/**
 * Resolve an ISRC to its Apple Music track URL, EXACTLY. A silent no-op until the
 * MusicKit secrets are provisioned (`{ configured: false }`), so the publish + backfill
 * paths work unprovisioned. Never throws: a network/token error surfaces as
 * `{ ok: false }` (with `rateLimited` set on an HTTP 429), matching `lastfmLove`'s
 * discipline so the Worker-paced backfill can back a throttled finding off.
 */
export async function appleMusicLookupByIsrc(isrc: string): Promise<AppleMusicLookupOutcome> {
  const clean = isrc.trim();

  if (!clean) {
    // No ISRC ⇒ nothing to resolve. Report as configured-but-no-match so the caller
    // records a clean `tried` rather than treating it as an unprovisioned no-op.
    return { configured: true, ok: true, url: null };
  }

  const credentials = await readAppleMusicCredentials();

  if (!credentials) {
    return { configured: false };
  }

  try {
    const token = await developerToken(credentials);
    const url = `${CATALOG_SONGS_URL}?filter%5Bisrc%5D=${encodeURIComponent(clean)}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
      },
    });

    if (response.status === 429) {
      return {
        configured: true,
        error: `Apple Music request failed: 429 ${response.statusText}`,
        ok: false,
        rateLimited: true,
      };
    }

    if (!response.ok) {
      // A 401/403 here is a bad/expired/SUSPENDED token: drop the cache so the next tick
      // re-mints, and flag it so the caller can feed the cross-cutting breaker (apple-breaker.ts)
      // — K consecutive 401/403 is the failure regime that darkens every Apple surface at once.
      const authFailed = response.status === 401 || response.status === 403;

      if (authFailed) {
        cachedToken = undefined;
      }

      return {
        authFailed,
        configured: true,
        error: `Apple Music request failed: ${response.status} ${response.statusText}`,
        ok: false,
        rateLimited: false,
      };
    }

    const body = await response.json().catch(() => ({}));

    return { configured: true, ok: true, url: extractAppleMusicUrl(body) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("error", "apple-music.lookup-failed", { error, isrc: clean });

    return { configured: true, error: message, ok: false, rateLimited: false };
  }
}

// ── The catalog oracle (RFC musickit-second-authority, U0) ─────────────────────
//
// One ISRC read, fanned out — with two honest entry points. A single Apple catalog
// response carries everything at once (URL, album facts, artwork, preview), so no
// downstream workstream ever fires its own bespoke Apple integration. But the two
// paths differ by design:
//
//   - `appleCatalogLookupByIsrc(isrc)` — single ISRC, `&include=albums`. The
//     canonical-album picker runs HERE and only here (the full pressing set is
//     reachable, with album attributes joined from the TOP-LEVEL `included[]` array
//     by id — the albums are NOT nested under the song). Carries recordLabel + album
//     artwork provenance. Used by the pilot, U2's recordLabel cross-check, U3's
//     artwork.
//   - `appleCatalogLookupByIsrcs(isrcs[])` — batched, ≤25 per request. NO picker;
//     takes Apple's `data[]` primary per ISRC (fine for a URL/preview — any pressing
//     geo-resolves to the recording). Used by U1's bulk URL/preview drain.
//
// The rule that keeps them honest: recordLabel + artwork-source decisions ride the
// single-ISRC path; the URL/preview drain rides the batched path.

/**
 * The `{w}x{h}bb.jpg`-templated artwork Apple returns on both a song and an album.
 * `urlTemplate` is the raw `attributes.artwork.url` with its `{w}`/`{h}` tokens
 * intact; `appleArtworkUrl` substitutes them. The palette fields (`bgColor`,
 * `textColor1..4`) are hex-without-`#` strings Apple derives from the cover.
 */
export type AppleArtwork = {
  urlTemplate: string;
  width: number;
  height: number;
  bgColor?: string;
  textColor1?: string;
  textColor2?: string;
  textColor3?: string;
  textColor4?: string;
};

/**
 * The full fanned-out bundle from ONE single-ISRC catalog read. `canonicalAlbum` is
 * the picker's output (present only on the single-ISRC path, and only when a
 * non-compilation album object was actually included — see the honest-miss note on
 * `buildCatalogBundle`). `editorialNotes*` are HTML-bearing and consumed at context
 * build, never stored. `songId` is storefront-scoped and re-resolvable, never eternal.
 */
export type AppleCatalogBundle = {
  songUrl: string;
  songId: string;
  songArtwork?: AppleArtwork;
  canonicalAlbum?: {
    id: string;
    recordLabel?: string;
    upc?: string;
    editorialNotesStandard?: string;
    editorialNotesShort?: string;
    artwork?: AppleArtwork;
  };
  preview?: { url: string };
};

/**
 * The slimmer per-ISRC bundle from the batched path: no album facts (no picker), just
 * the URL/preview/artwork the bulk drain needs. Keyed by the requested ISRC.
 */
export type AppleCatalogBatchBundle = {
  songUrl: string;
  songId: string;
  songArtwork?: AppleArtwork;
  preview?: { url: string };
};

/**
 * A parsed album candidate — the fields the picker ranks on plus what the bundle
 * carries. `isCompilation`/`isSingle` are Apple's editorial flags (absent ⇒ treated
 * as false: an ordinary album). Exported so the pilot can report the multi-pressing
 * and distributor-recordLabel distributions off real data.
 */
export type AppleAlbumCandidate = {
  id: string;
  recordLabel?: string;
  upc?: string;
  releaseDate?: string;
  isCompilation?: boolean;
  isSingle?: boolean;
  editorialNotesStandard?: string;
  editorialNotesShort?: string;
  artwork?: AppleArtwork;
};

// The maximum ISRCs Apple accepts on one `filter[isrc]` request (documented cap).
const CATALOG_ISRC_BATCH_MAX = 25;

// The raw JSON-API shapes we read off the catalog `songs` response. Everything is
// optional: Apple omits absent facts, and a builder that assumes presence reads
// `undefined` — so we narrow at every hop.
type AppleRawArtwork = {
  url?: string;
  width?: number;
  height?: number;
  bgColor?: string;
  textColor1?: string;
  textColor2?: string;
  textColor3?: string;
  textColor4?: string;
};

type AppleRawResourceRef = { id?: string; type?: string };

type AppleRawSong = {
  id?: string;
  type?: string;
  attributes?: {
    url?: string;
    isrc?: string;
    artwork?: AppleRawArtwork;
    previews?: Array<{ url?: string }>;
  };
  // With `include=albums`, Apple INLINES the full album objects here — each entry
  // carries `attributes` directly (verified live 2026-07-12: no top-level `included[]`
  // arrives at all, contra generic JSON:API convention). The `AppleRawAlbum` shape
  // covers both the bare-ref and the inlined-attributes forms.
  relationships?: { albums?: { data?: AppleRawAlbum[] } };
};

type AppleRawAlbum = {
  id?: string;
  type?: string;
  attributes?: {
    recordLabel?: string;
    upc?: string;
    releaseDate?: string;
    isCompilation?: boolean;
    isSingle?: boolean;
    editorialNotes?: { standard?: string; short?: string };
    artwork?: AppleRawArtwork;
  };
};

type AppleRawCatalogResponse = {
  data?: AppleRawSong[];
  included?: AppleRawAlbum[];
  meta?: { filters?: { isrc?: Record<string, AppleRawResourceRef[]> } };
};

/**
 * Substitute an artwork template's `{w}`/`{h}` tokens, CLAMPED to the artwork's
 * native max so we never ask Apple to upscale past the source (the render pipeline's
 * 300²-into-1920² defect the RFC ties off). A non-positive request falls back to the
 * native dimension.
 */
export function appleArtworkUrl(artwork: AppleArtwork, width: number, height: number): string {
  const w = width > 0 ? Math.min(width, artwork.width) : artwork.width;
  const h = height > 0 ? Math.min(height, artwork.height) : artwork.height;

  return artwork.urlTemplate.replace("{w}", String(w)).replace("{h}", String(h));
}

/**
 * The render pipeline's target artwork edge (px). The RFC's U3a fix closes the video
 * render's 300²-into-1920² upscale by asking Apple's `{w}x{h}` template for a ≥1920
 * source; 2048 clears that with headroom and is CLAMPED to the artwork's native max by
 * `appleArtworkUrl`, so a smaller master is never upscaled. RENDER-TIME ONLY — never
 * persisted (decision A: the 3000² original is never stored; only this ephemeral,
 * server-composed URL feeds the films, the same posture as today's render-time Spotify
 * fetch).
 */
export const RENDER_ARTWORK_TARGET_PX = 2048;

/**
 * Compose a square, render-grade artwork URL from an album's STORED Apple facts
 * (`albums.artwork_url_template` + `artwork_width`/`artwork_height`, written once per
 * album by U1's sweep). Returns undefined when the template or dimensions are absent —
 * the honest "no Apple cover", which lets the DTO fall through to the Spotify floor.
 * `target` defaults to `RENDER_ARTWORK_TARGET_PX` and is clamped to native by
 * `appleArtworkUrl`. Pure (no token, no network): the DTO composes it server-side so
 * `packages/video` stays a dumb consumer that never imports apps/web.
 */
export function composeAppleArtworkUrl(
  urlTemplate: string | null | undefined,
  width: number | null | undefined,
  height: number | null | undefined,
  target: number = RENDER_ARTWORK_TARGET_PX,
): string | undefined {
  if (
    !urlTemplate ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }

  return appleArtworkUrl({ height, urlTemplate, width }, target, target);
}

// Map Apple's raw artwork to our shape, or undefined when the template/dimensions
// are missing (art we could not substitute is art we do not claim to have).
function parseArtwork(raw: AppleRawArtwork | undefined): AppleArtwork | undefined {
  if (!raw || typeof raw.url !== "string" || !raw.url.trim()) {
    return undefined;
  }

  const width = typeof raw.width === "number" ? raw.width : 0;
  const height = typeof raw.height === "number" ? raw.height : 0;

  return {
    bgColor: raw.bgColor,
    height,
    textColor1: raw.textColor1,
    textColor2: raw.textColor2,
    textColor3: raw.textColor3,
    textColor4: raw.textColor4,
    urlTemplate: raw.url.trim(),
    width,
  };
}

function parseAlbum(raw: AppleRawAlbum): AppleAlbumCandidate | undefined {
  if (typeof raw.id !== "string" || !raw.id) {
    return undefined;
  }

  const attributes = raw.attributes ?? {};

  return {
    artwork: parseArtwork(attributes.artwork),
    editorialNotesShort: attributes.editorialNotes?.short,
    editorialNotesStandard: attributes.editorialNotes?.standard,
    id: raw.id,
    isCompilation: attributes.isCompilation,
    isSingle: attributes.isSingle,
    recordLabel: attributes.recordLabel?.trim() ? attributes.recordLabel.trim() : undefined,
    releaseDate: attributes.releaseDate,
    upc: attributes.upc?.trim() ? attributes.upc.trim() : undefined,
  };
}

/**
 * Collect the album candidates for the picker: every album the response's songs
 * reference via `relationships.albums.data[]`. With `include=albums`, Apple INLINES
 * the full album objects there — each entry carries `attributes` directly. (Verified
 * live 2026-07-12 against the real API: NO top-level `included[]` arrives, contra the
 * generic JSON:API convention this first shipped against — the pilot read 0 albums on
 * 43/43 hits until this join was corrected.) A top-level `included[]` lookup is kept
 * as a fallback in case any response variant ever ships one. Exported pure — the
 * adversarial case (the primary song belongs to BOTH a distributor compilation and
 * its original album) is exactly what this feeds the picker. A bare ref with no
 * attributes anywhere simply drops out — the honest miss the bundle then reports as
 * `canonicalAlbum: undefined`.
 */
export function collectAlbumCandidates(body: unknown): AppleAlbumCandidate[] {
  const response = (body ?? {}) as AppleRawCatalogResponse;
  const included = Array.isArray(response.included) ? response.included : [];
  const songs = Array.isArray(response.data) ? response.data : [];

  const albumsById = new Map<string, AppleAlbumCandidate>();

  for (const raw of included) {
    if (raw.type === "albums") {
      const album = parseAlbum(raw);

      if (album) {
        albumsById.set(album.id, album);
      }
    }
  }

  const candidates: AppleAlbumCandidate[] = [];
  const seen = new Set<string>();

  for (const song of songs) {
    for (const ref of song.relationships?.albums?.data ?? []) {
      const id = ref.id;

      if (typeof id !== "string" || seen.has(id)) {
        continue;
      }

      // Prefer the inlined album object (the real shape); fall back to an
      // `included[]` resolution should one ever arrive.
      const album = (ref.attributes ? parseAlbum(ref) : undefined) ?? albumsById.get(id);

      if (album) {
        seen.add(id);
        candidates.push(album);
      }
    }
  }

  return candidates;
}

// The picker's precedence, as a comparator (`< 0` ⇒ `a` ranks ahead of `b`):
//   1. NON-compilation over compilation  (a distributor compilation is the trap).
//   2. earliest releaseDate              (missing date sorts last).
//   3. NON-single over single            (the album pressing over the single).
//   4. deterministic id tiebreak         (ascending, so the pick is stable).
function compareAlbumCandidates(a: AppleAlbumCandidate, b: AppleAlbumCandidate): number {
  const compilationRank = (a.isCompilation === true ? 1 : 0) - (b.isCompilation === true ? 1 : 0);

  if (compilationRank !== 0) {
    return compilationRank;
  }

  const aDate = a.releaseDate ?? "9999-99-99";
  const bDate = b.releaseDate ?? "9999-99-99";

  if (aDate !== bDate) {
    return aDate < bDate ? -1 : 1;
  }

  const singleRank = (a.isSingle === true ? 1 : 0) - (b.isSingle === true ? 1 : 0);

  if (singleRank !== 0) {
    return singleRank;
  }

  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }

  return 0;
}

/**
 * The canonical-album picker (exported pure): prefer `isCompilation: false` →
 * earliest `releaseDate` → non-single over single → deterministic id tiebreak.
 * Returns the top-ranked candidate, or undefined for an empty set. It ALWAYS
 * returns a candidate when given one — the "is this good enough to surface?" gate
 * (a compilation-only set is an honest miss) lives in `buildCatalogBundle`, so the
 * picker stays a pure ranking.
 */
export function pickCanonicalAlbum(albums: AppleAlbumCandidate[]): AppleAlbumCandidate | undefined {
  if (albums.length === 0) {
    return undefined;
  }

  return [...albums].sort(compareAlbumCandidates)[0];
}

function parsePreview(previews: Array<{ url?: string }> | undefined): { url: string } | undefined {
  const url = previews?.[0]?.url;

  return typeof url === "string" && url.trim() ? { url: url.trim() } : undefined;
}

/**
 * Build the fanned-out bundle from a single-ISRC (`&include=albums`) response, or
 * null when the ISRC matched nothing (`data: []`, or a primary with no URL).
 * Exported pure for fixture tests.
 *
 * HONEST MISS: the picker prefers a non-compilation, so `canonicalAlbum` is surfaced
 * only when the picked album is NOT a compilation. Where the primary belongs solely
 * to a distributor compilation (whose `recordLabel` is the distributor, not the
 * imprint), `canonicalAlbum` is undefined — we do not launder a distributor string
 * into the graph. Fetching one alternate href to recover the original is a budgeted
 * follow-up left to the consumer that needs it (not this unit).
 */
export function buildCatalogBundle(body: unknown): AppleCatalogBundle | null {
  const response = (body ?? {}) as AppleRawCatalogResponse;
  const primary = Array.isArray(response.data) ? response.data[0] : undefined;
  const songUrl = primary?.attributes?.url;

  if (
    !primary ||
    typeof primary.id !== "string" ||
    typeof songUrl !== "string" ||
    !songUrl.trim()
  ) {
    return null;
  }

  const picked = pickCanonicalAlbum(collectAlbumCandidates(response));
  const canonical = picked && picked.isCompilation !== true ? picked : undefined;

  const bundle: AppleCatalogBundle = {
    songId: primary.id,
    songUrl: songUrl.trim(),
  };

  const songArtwork = parseArtwork(primary.attributes?.artwork);

  if (songArtwork) {
    bundle.songArtwork = songArtwork;
  }

  const preview = parsePreview(primary.attributes?.previews);

  if (preview) {
    bundle.preview = preview;
  }

  if (canonical) {
    bundle.canonicalAlbum = {
      artwork: canonical.artwork,
      editorialNotesShort: canonical.editorialNotesShort,
      editorialNotesStandard: canonical.editorialNotesStandard,
      id: canonical.id,
      recordLabel: canonical.recordLabel,
      upc: canonical.upc,
    };
  }

  return bundle;
}

/**
 * Map each requested ISRC to its `data[]` primary via `meta.filters.isrc` (the
 * batched path: Apple returns ONE primary song per ISRC in `data[]`, and lists all
 * pressings as bare refs under `meta.filters.isrc[<ISRC>]`). Exported pure for tests.
 * An ISRC with no match is simply absent from the map (an honest miss).
 */
export function buildBatchBundles(
  body: unknown,
  requestedIsrcs: string[],
): Map<string, AppleCatalogBatchBundle> {
  const response = (body ?? {}) as AppleRawCatalogResponse;
  const songs = Array.isArray(response.data) ? response.data : [];
  const filters = response.meta?.filters?.isrc ?? {};

  const songsById = new Map<string, AppleRawSong>();

  for (const song of songs) {
    if (typeof song.id === "string") {
      songsById.set(song.id, song);
    }
  }

  const bundles = new Map<string, AppleCatalogBatchBundle>();

  for (const isrc of requestedIsrcs) {
    // Prefer the meta mapping (the documented ISRC → pressings index); fall back to
    // the song's own stamped `attributes.isrc` when meta is absent.
    const refIds = new Set((filters[isrc] ?? []).map((ref) => ref.id).filter(Boolean));

    const primary =
      songs.find((song) => typeof song.id === "string" && refIds.has(song.id)) ??
      songs.find((song) => song.attributes?.isrc === isrc);

    const songUrl = primary?.attributes?.url;

    if (
      !primary ||
      typeof primary.id !== "string" ||
      typeof songUrl !== "string" ||
      !songUrl.trim()
    ) {
      continue;
    }

    const bundle: AppleCatalogBatchBundle = { songId: primary.id, songUrl: songUrl.trim() };
    const songArtwork = parseArtwork(primary.attributes?.artwork);

    if (songArtwork) {
      bundle.songArtwork = songArtwork;
    }

    const preview = parsePreview(primary.attributes?.previews);

    if (preview) {
      bundle.preview = preview;
    }

    bundles.set(isrc, bundle);
  }

  return bundles;
}

/**
 * The low-level authed catalog GET, sharing the token mint/cache and the exact
 * failure discipline of `appleMusicLookupByIsrc` (429 ⇒ back off hard; a 401/403
 * bad-token drops the cache so the next tick re-mints; any other non-2xx is a plain
 * error). `query` is the querystring after `?`. Never throws. Exported so the pilot
 * can drive one authed read per ISRC and derive its diagnostics from the raw body
 * with the pure parsers above — the same path the two lookups take internally.
 *
 * `signal` is optional so a user-facing hot-path caller (U4's live preview rung) can
 * bound the call with a short timeout, aborting the underlying fetch instead of leaking
 * it — an aborted fetch throws, which surfaces here as a plain `{ ok: false }` (the
 * caller falls through to its keyless fallback). The sweeps pass no signal.
 */
export type AppleCatalogRequestOutcome =
  | { configured: false }
  | { configured: true; ok: true; body: unknown }
  | { authFailed?: boolean; configured: true; error: string; ok: false; rateLimited: boolean };

export async function requestAppleCatalog(
  query: string,
  signal?: AbortSignal,
): Promise<AppleCatalogRequestOutcome> {
  const credentials = await readAppleMusicCredentials();

  if (!credentials) {
    return { configured: false };
  }

  try {
    const token = await developerToken(credentials);

    const response = await fetch(`${CATALOG_SONGS_URL}?${query}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
      },
      signal,
    });

    if (response.status === 429) {
      return {
        configured: true,
        error: `Apple Music request failed: 429 ${response.statusText}`,
        ok: false,
        rateLimited: true,
      };
    }

    if (!response.ok) {
      // A 401/403 is a bad/SUSPENDED token: drop the cache AND flag it so the caller feeds the
      // cross-cutting breaker (apple-breaker.ts). This is U0's single point of failure — one bad
      // token fails every downstream unit's Apple rung at once.
      const authFailed = response.status === 401 || response.status === 403;

      if (authFailed) {
        cachedToken = undefined;
      }

      return {
        authFailed,
        configured: true,
        error: `Apple Music request failed: ${response.status} ${response.statusText}`,
        ok: false,
        rateLimited: false,
      };
    }

    const body = await response.json().catch(() => ({}));

    return { body, configured: true, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("error", "apple-music.catalog-failed", { error, query });

    return { configured: true, error: message, ok: false, rateLimited: false };
  }
}

/**
 * The single-ISRC catalog read: the canonical-album picker runs here. A silent no-op
 * until the MusicKit secrets are provisioned (`{ configured: false }`). `bundle` is
 * null when the ISRC matched nothing. Never throws (the request layer maps errors to
 * `{ ok: false }`, `rateLimited` on a 429).
 */
export type AppleCatalogLookupOutcome =
  | { configured: false }
  | { configured: true; ok: true; bundle: AppleCatalogBundle | null }
  | { authFailed?: boolean; configured: true; error: string; ok: false; rateLimited: boolean };

export async function appleCatalogLookupByIsrc(isrc: string): Promise<AppleCatalogLookupOutcome> {
  const clean = isrc.trim();

  if (!clean) {
    return { bundle: null, configured: true, ok: true };
  }

  const outcome = await requestAppleCatalog(
    `filter%5Bisrc%5D=${encodeURIComponent(clean)}&include=albums`,
  );

  if (!outcome.configured) {
    return { configured: false };
  }

  if (!outcome.ok) {
    return {
      authFailed: outcome.authFailed,
      configured: true,
      error: outcome.error,
      ok: false,
      rateLimited: outcome.rateLimited,
    };
  }

  return { bundle: buildCatalogBundle(outcome.body), configured: true, ok: true };
}

/**
 * The batched catalog read: NO picker, ≤25 ISRCs per request (validated + chunked),
 * each mapped to its `data[]` primary. A silent no-op until configured. On the first
 * chunk that errors, the whole call surfaces that error (`rateLimited` preserved) so
 * the caller re-drives from a clean state; otherwise the per-ISRC bundles merge into
 * one map. ISRCs with no match are absent from the map.
 *
 * This is the SLIM path (no `&include=albums`) — the lightest catalog read that still
 * carries the URL/preview/artwork, so a single-ISRC caller that only needs the preview
 * (U4's live rung) drives it with a one-element list rather than paying for the album
 * join. `signal` bounds that hot-path call with a timeout (see `requestAppleCatalog`).
 */
export type AppleCatalogBatchOutcome =
  | { configured: false }
  | { configured: true; ok: true; bundles: Map<string, AppleCatalogBatchBundle> }
  | { authFailed?: boolean; configured: true; error: string; ok: false; rateLimited: boolean };

export async function appleCatalogLookupByIsrcs(
  isrcs: string[],
  signal?: AbortSignal,
): Promise<AppleCatalogBatchOutcome> {
  // Validate + dedupe: trim, drop empties, keep first-seen order.
  const clean: string[] = [];
  const seen = new Set<string>();

  for (const raw of isrcs) {
    const value = raw.trim();

    if (value && !seen.has(value)) {
      seen.add(value);
      clean.push(value);
    }
  }

  if (clean.length === 0) {
    return { bundles: new Map(), configured: true, ok: true };
  }

  const bundles = new Map<string, AppleCatalogBatchBundle>();

  for (let start = 0; start < clean.length; start += CATALOG_ISRC_BATCH_MAX) {
    const chunk = clean.slice(start, start + CATALOG_ISRC_BATCH_MAX);
    const outcome = await requestAppleCatalog(
      `filter%5Bisrc%5D=${chunk.map((value) => encodeURIComponent(value)).join(",")}`,
      signal,
    );

    if (!outcome.configured) {
      return { configured: false };
    }

    if (!outcome.ok) {
      return {
        authFailed: outcome.authFailed,
        configured: true,
        error: outcome.error,
        ok: false,
        rateLimited: outcome.rateLimited,
      };
    }

    for (const [isrc, bundle] of buildBatchBundles(outcome.body, chunk)) {
      bundles.set(isrc, bundle);
    }
  }

  return { bundles, configured: true, ok: true };
}
