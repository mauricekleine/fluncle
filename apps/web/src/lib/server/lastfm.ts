// Worker-safe (HTTP-only) Last.fm write side: a signed `track.love` fired on
// publish, plus the one-time desktop-auth flow (auth.getToken → browser approve →
// auth.getSession) that mints the durable session key.
//
// Why `love`, not `scrobble`: a scrobble claims "Fluncle listened just now",
// which would fabricate a listening history. A Loved Track is an explicit
// endorsement — exactly what a certified finding is.
//
// All write methods require authentication. Every authenticated call is signed:
// `api_sig = md5( <all params name+value, alphabetized, concatenated> + shared_secret )`,
// with the `format`/`callback` params excluded from the signature (verified
// against last.fm/api via Context7, 2026-06-20). The call carries `api_key`,
// `sk` (session key), and `api_sig`; requests are POST, form-urlencoded.
//
// The three durable credentials are Worker secrets (env.ts): LASTFM_API_KEY,
// LASTFM_SHARED_SECRET, LASTFM_SESSION_KEY. The first two come from the Last.fm
// API application; the session key comes from running `fluncle admin auth lastfm`.

import { createHash } from "node:crypto";
import { readEnvs, readOptionalEnv } from "./env";

const API_ROOT = "https://ws.audioscrobbler.com/2.0/";
// Last.fm wants an identifiable User-Agent on every call (same discipline as the
// Discogs/Deezer lookups). Fluncle, the curation side-project.
const USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

// Params the signature deliberately excludes (per the Last.fm auth spec).
const SIGNATURE_EXCLUDED = new Set(["api_sig", "callback", "format"]);

type LastfmError = { error?: number; message?: string };

// Last.fm error 29 = "Rate limit exceeded" (the JSON-body code; an HTTP 429 carries
// it too). Errors 11 (service offline) and 16 (temporary) are also "try again
// later" signals — the backfill treats all three as a retryable rate-limit/backoff
// hit rather than a permanent failure. See docs (Context7 last_fm_api, 2026-06-22).
const LASTFM_RETRYABLE_ERRORS = new Set([11, 16, 29]);

/**
 * Whether a `lastfmLove` outcome was a retryable rate-limit/backoff hit (HTTP 429
 * or Last.fm error 11/16/29) vs a clean success or a permanent failure. The
 * publish path ignores this (it fires once, best-effort); the Worker-paced
 * backfill reads it to back a finding off hard on a rate-limit hit.
 */
export type LastfmLoveOutcome =
  | { ok: true }
  | { error: string; ok: false; rateLimited: boolean; retryAfterMs?: number };

// A signal raised by callLastfm when a request was rate-limited, so lastfmLove can
// distinguish a 429/error-29 from any other failure without re-parsing the message.
class LastfmRateLimitError extends Error {
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "LastfmRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Build the `api_sig` for a signed call: alphabetize every signed param, join
 * them as `<name><value>` with no separators, append the shared secret, MD5.
 * Exported for unit tests — this is the load-bearing, easy-to-get-wrong bit.
 */
export function signLastfmParams(params: Record<string, string>, sharedSecret: string): string {
  const concatenated = Object.keys(params)
    .filter((key) => !SIGNATURE_EXCLUDED.has(key))
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");

  return createHash("md5").update(`${concatenated}${sharedSecret}`, "utf8").digest("hex");
}

/**
 * Sign a param set, attach `api_sig` + `format=json`, and POST it form-urlencoded
 * to the Last.fm root. Returns the parsed JSON (Last.fm answers errors with HTTP
 * 200 + an `{ error, message }` body, so callers must check `error`).
 */
async function callLastfm(params: Record<string, string>, sharedSecret: string): Promise<unknown> {
  const apiSig = signLastfmParams(params, sharedSecret);
  const body = new URLSearchParams({ ...params, api_sig: apiSig, format: "json" });

  const response = await fetch(API_ROOT, {
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    method: "POST",
  });

  // Even non-2xx bodies carry the Last.fm error envelope; parse before throwing.
  const json = (await response.json().catch(() => ({}))) as LastfmError;

  // A rate-limit/backoff hit (HTTP 429, or a Last.fm 11/16/29 body code) is raised
  // as a distinct signal so a paced caller can back off rather than retry-storm.
  // Honour a Retry-After header when present (Last.fm rarely sends one, so the
  // caller supplies a default backoff when retryAfterMs is undefined).
  const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));

  if (response.status === 429) {
    throw new LastfmRateLimitError(
      `Last.fm request failed: 429 ${response.statusText}`,
      retryAfterMs,
    );
  }

  if (typeof json.error === "number") {
    if (LASTFM_RETRYABLE_ERRORS.has(json.error)) {
      throw new LastfmRateLimitError(
        `Last.fm error ${json.error}: ${json.message ?? "unknown"}`,
        retryAfterMs,
      );
    }

    throw new Error(`Last.fm error ${json.error}: ${json.message ?? "unknown"}`);
  }

  if (!response.ok) {
    throw new Error(`Last.fm request failed: ${response.status} ${response.statusText}`);
  }

  return json;
}

/** Parse a `Retry-After` header (delta-seconds; HTTP-date form is ignored) → ms. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }

  const seconds = Number(header);

  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Best-effort `track.love` (a Loved Track = an explicit endorsement). Fired once
 * per newly published finding, matched by `{artist, track}` strings (Last.fm has
 * no ISRC lookup). Never throws and never blocks the publish — same discipline as
 * postToTelegram / the Deezer enrichment: a miss is logged and the add continues.
 *
 * No-ops silently when Last.fm isn't configured (no session key yet), so the
 * publish path works before Maurice provisions the credentials. The publish path
 * ignores the return; the Worker-paced backfill reads the `LastfmLoveOutcome` to
 * record the result and back a rate-limited finding off hard (a clean `{ ok: true }`
 * covers both a real love and the configured-no-op, since both mean "no work owed").
 */
export async function lastfmLove(artist: string, track: string): Promise<LastfmLoveOutcome> {
  const cleanArtist = artist.trim();
  const cleanTrack = track.trim();

  if (!cleanArtist || !cleanTrack) {
    return { ok: true };
  }

  try {
    const sessionKey = await readOptionalEnv("LASTFM_SESSION_KEY");

    if (!sessionKey) {
      // Not connected yet — silently no-op (the love hook is provisioned later).
      return { ok: true };
    }

    const env = await readEnvs(["LASTFM_API_KEY", "LASTFM_SHARED_SECRET"]);

    await callLastfm(
      {
        api_key: env.LASTFM_API_KEY,
        artist: cleanArtist,
        method: "track.love",
        sk: sessionKey,
        track: cleanTrack,
      },
      env.LASTFM_SHARED_SECRET,
    );

    return { ok: true };
  } catch (error) {
    // Side-channel: log and continue. Loving is idempotent, so a later retry/
    // backfill is harmless; the add must never fail on a Last.fm miss.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Last.fm love failed for "${artist} — ${track}": ${message}`);

    if (error instanceof LastfmRateLimitError) {
      return { error: message, ok: false, rateLimited: true, retryAfterMs: error.retryAfterMs };
    }

    return { error: message, ok: false, rateLimited: false };
  }
}

/**
 * Step 1 of the desktop auth flow: `auth.getToken` (signed with api_key + method
 * + secret) → an unauthorized request token. The token is then approved in-browser
 * at the authorize URL. Returns both for the CLI to print.
 */
export async function lastfmGetToken(): Promise<{ authUrl: string; token: string }> {
  const env = await readEnvs(["LASTFM_API_KEY", "LASTFM_SHARED_SECRET"]);
  const result = (await callLastfm(
    { api_key: env.LASTFM_API_KEY, method: "auth.getToken" },
    env.LASTFM_SHARED_SECRET,
  )) as { token?: string };

  if (!result.token) {
    throw new Error("Last.fm auth.getToken returned no token");
  }

  const authUrl = `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(
    env.LASTFM_API_KEY,
  )}&token=${encodeURIComponent(result.token)}`;

  return { authUrl, token: result.token };
}

/**
 * Step 3 of the desktop auth flow: after the user approves the token in-browser,
 * `auth.getSession` (signed) trades the now-authorized token for a durable session
 * key. The key does not expire — it becomes the LASTFM_SESSION_KEY Worker secret.
 */
export async function lastfmGetSession(
  token: string,
): Promise<{ name: string; sessionKey: string }> {
  const env = await readEnvs(["LASTFM_API_KEY", "LASTFM_SHARED_SECRET"]);
  const result = (await callLastfm(
    { api_key: env.LASTFM_API_KEY, method: "auth.getSession", token: token.trim() },
    env.LASTFM_SHARED_SECRET,
  )) as { session?: { key?: string; name?: string } };

  if (!result.session?.key) {
    throw new Error("Last.fm auth.getSession returned no session key");
  }

  return { name: result.session.name ?? "", sessionKey: result.session.key };
}
