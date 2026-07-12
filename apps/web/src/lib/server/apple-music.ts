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
  | { configured: true; error: string; ok: false; rateLimited: boolean };

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
      // A 401/403 here is a bad/expired token: drop the cache so the next tick re-mints.
      if (response.status === 401 || response.status === 403) {
        cachedToken = undefined;
      }

      return {
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
