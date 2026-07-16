import { createHmac, timingSafeEqual } from "node:crypto";

// The injectable `fetch` — the default is the global `fetch`; tests pass a fake that
// routes by URL, so every fetch+parse leg (the reach collectors, the OAuth token
// helpers) is unit-testable with zero real network. Its canonical home is here (a leaf
// module) so any server module can import it without a cycle.
export type FetchImpl = typeof fetch;

let didLoadLocalEnv = false;

const envKeys = [
  // Admin "Login with Spotify" allow-list — the operator identity, kept out of
  // this public repo. ADMIN_ALLOWED_EMAILS is required; ADMIN_ALLOWED_SPOTIFY_IDS
  // is optional. Both are comma-separated (see admin-auth.ts).
  "ADMIN_ALLOWED_EMAILS",
  "ADMIN_ALLOWED_SPOTIFY_IDS",
  // HMAC signing key for admin-session cookies AND OAuth state (signState /
  // verifySignedState). DELIBERATELY SEPARATE from FLUNCLE_API_TOKEN (the API
  // Bearer carrier): the agent box holds the API token, so sharing one secret
  // would let a token leak forge {role:"admin"} session cookies. Splitting them
  // means a leaked Bearer token cannot mint web sessions.
  "ADMIN_SESSION_SECRET",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  // Cartesia (Sonic) TTS — the audio-observation voice (Worker-side; the agent never
  // holds it). CARTESIA_API_KEY is a secret; CARTESIA_VOICE_ID is the swappable config
  // var holding the cloned Fluncle voice id, read via readOptionalEnv so an
  // unprovisioned Worker degrades cleanly.
  "CARTESIA_API_KEY",
  "CARTESIA_VOICE_ID",
  "FIRECRAWL_API_KEY",
  "FLUNCLE_API_TOKEN",
  // The Hermes box's admin Bearer. A SECOND, lower-privilege admin token: it
  // authenticates as the "agent" role (see adminRole / requireOperator), which is
  // bounded server-side to the reversible/internal surface — reads, enrich-sweep,
  // analysis write-back, a TikTok draft. It can NEVER hit a publish-/irreversible-
  // class route even with full shell access on the box, because the credential
  // itself lacks that authority here. The full FLUNCLE_API_TOKEN (the operator's
  // own CLI) and the browser grant cookie are the "operator" role. OPTIONAL —
  // unset means no agent principal exists and the surface is operator-only.
  "FLUNCLE_AGENT_TOKEN",
  // Resend — the newsletter's send-of-record.
  // The Worker owns the key; the agent box never holds it (the agent calls the
  // admin send op, the Worker creates + sends the broadcast). RESEND_API_KEY is the
  // secret; RESEND_SEGMENT_ID is the Fluncle Audience/Segment the subscribe path
  // adds contacts to AND the broadcast targets; RESEND_FROM is the verified sender
  // (e.g. "Fluncle <fluncle@newsletter.fluncle.com>"), read via readOptionalEnv so
  // a missing one is a clean 500 rather than a thrown Missing at module scope.
  "RESEND_API_KEY",
  "RESEND_SEGMENT_ID",
  "RESEND_FROM",
  "POSTIZ_API_KEY",
  "POSTIZ_API_URL",
  // R2 S3-API credentials for presigned direct-to-bucket uploads (the video
  // bundle bypasses the Worker body limit). The Worker owns these; the CLI only
  // ever holds the admin token + the short-lived presigned URLs they sign.
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  // Non-secret: the Cloudflare account id, wired as a plain var in wrangler.jsonc.
  "R2_ACCOUNT_ID",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_REDIRECT_URI",
  "SPOTIFY_PLAYLIST_ID",
  // "Continue with Google" public sign-in (Better Auth `socialProviders.google`,
  // lib/server/public-auth.ts). The OAuth client id + secret from the Google Cloud
  // console. Both OPTIONAL, read via readOptionalEnv: the Google provider is spread
  // into the auth config ONLY when BOTH are present, so the whole leg is a NO-OP
  // (and the "Continue with Google" button never renders) until they are set —
  // email/password sign-up + sign-in work unprovisioned exactly like the other
  // env-gated side-channels. Distinct from SPOTIFY_CLIENT_* (that is the ADMIN
  // "Login with Spotify" operator identity, not a public user provider).
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  // Our own YouTube OAuth (mixtape video distribution), mirroring Spotify. The
  // Worker holds the durable refresh token in youtube_auth and mints a short-lived
  // access token for the CLI's resumable upload PUT.
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_REDIRECT_URI",
  // A plain YouTube Data API v3 key (a `key=` query param, NOT OAuth) for the public
  // channel statistics the /reach collector reads (subscribers + total views). The
  // stats are public, so no OAuth ceremony — distinct from the YOUTUBE_CLIENT_* OAuth
  // above that the mixtape video distribution uses. OPTIONAL, read via readOptionalEnv:
  // absent, the reach collector skips the youtube platform cleanly (env-gated), exactly
  // like the Last.fm/Bluesky legs no-op unprovisioned.
  "YOUTUBE_API_KEY",
  // Our own Mixcloud OAuth (mixtape audio distribution). The Worker runs the code
  // exchange + stores the durable token in mixcloud_auth, then hands it to the CLI
  // just-in-time for the CLI-direct upload (the bytes are CLI-direct; the token is
  // not — the CLI stays a thin client). No redirect-URI var: Mixcloud takes it at
  // runtime, so it's derived from the request origin (mixcloudRedirectUri).
  "MIXCLOUD_CLIENT_ID",
  "MIXCLOUD_CLIENT_SECRET",
  // The /reach Tier-2 OAuth plumbing (docs/reach-tier2-activation.md) — one number
  // apiece behind a per-platform USER OAuth + refresh, mirroring the Spotify/YouTube
  // token dance (the durable token lives Worker-side in <platform>_auth, minted on
  // demand). All OPTIONAL, read via readOptionalEnv: every leg is DORMANT until its
  // creds are set AND the operator connects, so the reach collector skips the platform
  // cleanly (env-gated) exactly like the Last.fm/Bluesky legs no-op unprovisioned. The
  // redirect URI is derived from the request origin (like Mixcloud), so no *_REDIRECT_URI
  // var — the operator registers that exact callback URL in each platform's app console.
  //
  // Twitch — the broadcaster's OWN user token + `moderator:read:followers` (an app
  // token no longer suffices for the follower total). Client id/secret from the Twitch
  // developer console.
  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",
  // TikTok — Display API `user.info.stats` (own account only) for follower + likes
  // totals. `client_key`/`client_secret` from the TikTok developer app (note TikTok's
  // "client_key", not "client_id").
  // Instagram — the "Instagram API with Instagram Login" business flow (NOT the
  // Facebook-Login variant), `instagram_business_basic` scope → `followers_count`. The
  // Instagram App ID/Secret from the Meta app dashboard. The stored token is a 60-day
  // LONG-LIVED token (no refresh_token — it is refreshed in place via
  // graph.instagram.com/refresh_access_token), so instagram_auth carries no refresh column.
  "GITHUB_TOKEN",
  "INSTAGRAM_CLIENT_ID",
  "INSTAGRAM_CLIENT_SECRET",
  // Last.fm write side (love-on-add). API_KEY + SHARED_SECRET come from the
  // Last.fm API application; SESSION_KEY (durable, non-expiring) comes from
  // running `fluncle admin auth lastfm`. All three are Worker secrets. The love
  // hook no-ops when SESSION_KEY is absent, so the publish path works unprovisioned.
  "LASTFM_API_KEY",
  "LASTFM_SHARED_SECRET",
  "LASTFM_SESSION_KEY",
  // Apple Music API developer token, for the EXACT ISRC → Apple Music URL resolve
  // (lib/server/apple-music.ts, the `apple-music` backfill). Three parts of one
  // MusicKit key: TEAM_ID (the Apple Developer team), KEY_ID (the MusicKit key id),
  // and PRIVATE_KEY (the ES256 .p8 private key, PEM). The Worker mints a short-lived
  // ES256 JWT from them per the Apple Music API auth spec — the box never holds them.
  // All three read via readOptionalEnv, so the whole leg is a NO-OP until they are
  // set (exactly like Last.fm's session key): no URL is ever stored, and nothing wrong
  // is stored, while they are absent. Provisioning them requires an Apple Developer
  // MusicKit key (the keyless iTunes Search API has no ISRC lookup — that is the Apple
  // Music API, which needs this token). See docs/app-store-review.md.
  "APPLE_MUSIC_TEAM_ID",
  "APPLE_MUSIC_KEY_ID",
  "APPLE_MUSIC_PRIVATE_KEY",
  // Discogs read-only release-ID enrichment (lib/server/discogs.ts): a personal
  // access token created in the `fluncle` Discogs developer settings. It lifts the
  // rate limit to ~60 req/min and is read via readOptionalEnv, so the lookup
  // no-ops (in_release_id/in_master_id stay inert) until the secret is set.
  "DISCOGS_USER_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHANNEL_ID",
  "DISCORD_WEBHOOK_URL",
  // Bluesky (AT Protocol) publish side-channel (lib/server/bluesky.ts). The
  // handle/identifier + an app password (NOT the account password) for
  // @fluncle.com (a leading "@" in the stored value is fine — bluesky.ts strips
  // it). Both read via readOptionalEnv, so the whole leg is a NO-OP until
  // they're set — a publish is never touched while they're absent.
  "BLUESKY_IDENTIFIER",
  "BLUESKY_APP_PASSWORD",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  // Cloudflare cache purge-by-URL (lib/server/edge-cache.ts): when a finding is
  // published or updated, the Worker drops its `/log/<id>` page + the `/log` index
  // from the edge cache globally. Both OPTIONAL — absent, the purge degrades to a
  // local (this-data-center) eviction plus the short fresh window. CF_CACHE_PURGE_ZONE_ID
  // is the fluncle.com zone id (non-secret); CF_CACHE_PURGE_TOKEN is an API token
  // scoped to Zone → Cache Purge on that zone (a secret). Read off the Worker `env`
  // binding directly in edge-cache.ts, not via readEnv (they may be unset).
  "CF_CACHE_PURGE_ZONE_ID",
  "CF_CACHE_PURGE_TOKEN",
  // Expo Push Service access token for the mobile app's push notifications
  // (lib/server/push.ts). OPTIONAL and read via
  // readOptionalEnv: the whole push feature is a NO-OP until this is set — the
  // send-on-publish side-channel returns immediately, so the publish path works
  // unprovisioned exactly like the Last.fm/Telegram hooks. With Expo's "Enhanced
  // Security for Push" enabled this Bearer is REQUIRED for /send to authorize.
  "EXPO_ACCESS_TOKEN",
  // OpenRouter — the small-LLM distil pass that turns raw Firecrawl search snippets
  // into a clean context_note (lib/server/observation.ts). OPENROUTER_API_KEY is a
  // secret, read via readOptionalEnv so an unprovisioned Worker degrades gracefully:
  // the distil falls back to the cleaned raw snippets rather than blocking the
  // render. OPENROUTER_CONTEXT_MODEL is an OPTIONAL, non-secret override for the
  // distil model; absent, it defaults to `anthropic/claude-haiku-4.5`.
  "OPENROUTER_API_KEY",
  "OPENROUTER_CONTEXT_MODEL",
  // The same key drives search's fourth tier — the model that turns a natural-language query
  // into a filter object (lib/server/search-llm.ts). OPENROUTER_SEARCH_MODEL is the OPTIONAL,
  // non-secret override for THAT model (default `anthropic/claude-haiku-4.5`), kept separate
  // from the distil's so the two can be tuned independently: one is a summariser, the other a
  // parser. Unprovisioned, search degrades to full text and keeps working.
  "OPENROUTER_SEARCH_MODEL",
  // ChatDnB (the admin-gated /admin/chat spike, lib/server/chat.ts) — the model that
  // holds Fluncle's voice and answers over his own archive tools. OPTIONAL, non-secret
  // override for the chat model; absent, it defaults to `anthropic/claude-haiku-4.5`, the
  // same family the search + distil tiers trust. The chat itself needs OPENROUTER_API_KEY
  // (the shared key above); without it the route answers 503, since a chat has no cheaper
  // degraded fallback the way search degrades to full text.
  "OPENROUTER_CHAT_MODEL",
] as const;

export type EnvKey = (typeof envKeys)[number];

async function loadLocalEnv(): Promise<void> {
  if (!import.meta.env.DEV || didLoadLocalEnv) {
    return;
  }

  const { config } = await import("dotenv");

  config({ path: ".dev.vars" });

  didLoadLocalEnv = true;
}

export async function readEnv(key: EnvKey): Promise<string> {
  await loadLocalEnv();

  const value = process.env[key];

  if (!value) {
    throw new Error(`Missing ${key}`);
  }

  return value;
}

export async function readOptionalEnv(key: EnvKey): Promise<string | undefined> {
  await loadLocalEnv();

  const value = process.env[key];

  return value?.trim() ? value : undefined;
}

export async function readEnvs<const T extends readonly EnvKey[]>(
  keys: T,
): Promise<Record<T[number], string>> {
  await loadLocalEnv();

  return Object.fromEntries(
    keys.map((key) => {
      const value = process.env[key];

      if (!value) {
        throw new Error(`Missing ${key}`);
      }

      return [key, value];
    }),
  ) as Record<T[number], string>;
}

// One admin identity, two carriers: the CLI/agent
// send FLUNCLE_API_TOKEN as a Bearer header (requireAdmin compares it directly);
// the browser sends a signed grant COOKIE whose HMAC signing key is the SEPARATE
// ADMIN_SESSION_SECRET (admin-auth.ts), never a transported value. The two
// secrets are split so a leaked Bearer token cannot forge session cookies.
// requireAdmin accepts either, so every existing /api/admin/* route is reachable
// from the browser tagging UI without forking per-carrier logic.
export const ADMIN_COOKIE_NAME = "fluncle_admin";
// The browser session window. Deliberately NOT the OAuth state window: a 10-min
// cookie would log the single operator out mid-session.
export const ADMIN_GRANT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

// Two admin ROLES, not one admin with carriers:
//   - "operator" — the human. Carried by the browser grant cookie OR the full
//     FLUNCLE_API_TOKEN Bearer (the operator's own CLI). Can do everything.
//   - "agent" — Hermes (and the Discord allow-list). Carried by FLUNCLE_AGENT_TOKEN.
//     Bounded to the reversible/internal surface; publish-/irreversible-class
//     routes 403 it (requireOperator).
// Both are admin principals (they authenticate onto /api/admin/*); the role is the
// privilege. The split is what makes the box gate non-load-bearing: a compromised
// agent holds only the agent token, which the Worker refuses for publish actions.
export type AdminRole = "operator" | "agent";

// The role behind a request, or null if it is not an admin principal at all. This
// is the single source of truth both requireAdmin and requireOperator read from.
export async function adminRole(request: Request): Promise<AdminRole | null> {
  const header = request.headers.get("Authorization");
  const prefix = "Bearer ";
  const token = header?.startsWith(prefix) ? header.slice(prefix.length) : undefined;

  if (token) {
    const operatorToken = await readEnv("FLUNCLE_API_TOKEN");

    if (constantTimeEqual(token, operatorToken)) {
      return "operator";
    }

    const agentToken = await readOptionalEnv("FLUNCLE_AGENT_TOKEN");

    if (agentToken && constantTimeEqual(token, agentToken)) {
      return "agent";
    }
  }

  // The browser grant cookie is always the operator (it is minted only after
  // "Login with Spotify" against the operator allow-list).
  if (await hasValidAdminCookie(request)) {
    return "operator";
  }

  return null;
}

// Any admin principal (operator OR agent). Use at the top of agent-allowed routes:
// reads, enrich-sweep, and the conditional routes that then branch on adminRole.
export async function requireAdmin(request: Request): Promise<Response | undefined> {
  return (await adminRole(request)) ? undefined : unauthorized();
}

// Operator only. Use on every publish-/irreversible-class route: a valid agent
// token gets a 403 (it authenticated fine, it just lacks the role), a non-admin a
// 401. The browser cookie and the full token pass, so the human admin UI and the
// operator's own CLI are unaffected.
export async function requireOperator(request: Request): Promise<Response | undefined> {
  const role = await adminRole(request);

  if (role === "operator") {
    return undefined;
  }

  return role === "agent" ? forbidden() : unauthorized();
}

async function hasValidAdminCookie(request: Request): Promise<boolean> {
  const value = readCookie(request.headers.get("cookie"), ADMIN_COOKIE_NAME);

  if (!value) {
    return false;
  }

  try {
    const payload = await verifySignedState(value, ADMIN_GRANT_MAX_AGE_MS);

    return payload.role === "admin";
  } catch {
    return false;
  }
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) {
    return undefined;
  }

  for (const part of header.split(/;\s*/)) {
    // Split on the FIRST '=' only — base64url grant values can contain '='.
    const eq = part.indexOf("=");

    if (eq !== -1 && part.slice(0, eq) === name) {
      return part.slice(eq + 1);
    }
  }

  return undefined;
}

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    {
      code,
      message,
      ok: false,
    },
    { status },
  );
}

export async function signState(payload: Record<string, string | number>): Promise<string> {
  const secret = await readEnv("ADMIN_SESSION_SECRET");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");

  return `${body}.${signature}`;
}

// The HMAC verify primitive, shared by the OAuth state path and the admin
// session cookie. The two carriers differ ONLY in their freshness window, so it
// is a parameter — the OAuth path keeps its tight 10-min window while the admin
// session gets a 30-day one, off one signing implementation.
export async function verifySignedState(
  state: string,
  maxAgeMs: number,
): Promise<Record<string, unknown>> {
  const secret = await readEnv("ADMIN_SESSION_SECRET");
  const [body, signature] = state.split(".");

  if (!body || !signature) {
    throw new Error("Invalid state");
  }

  const expected = createHmac("sha256", secret).update(body).digest("base64url");

  if (!constantTimeEqual(signature, expected)) {
    throw new Error("Invalid state");
  }

  const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  const issuedAt = typeof parsed.iat === "number" ? parsed.iat : 0;

  if (Date.now() - issuedAt > maxAgeMs) {
    throw new Error("Expired state");
  }

  return parsed;
}

export async function verifyState(state: string): Promise<Record<string, unknown>> {
  return verifySignedState(state, OAUTH_STATE_MAX_AGE_MS);
}

function unauthorized(): Response {
  return jsonError(401, "unauthorized", "Missing or invalid admin token");
}

function forbidden(): Response {
  return jsonError(403, "forbidden", "This action requires the operator role");
}

// Exported for unit tests: Node's timingSafeEqual THROWS on length-mismatch, so
// the length guard is load-bearing — a missing guard turns an intended 401 into
// an unhandled 500. Tests assert the guard returns false (never throws/bypasses).
export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
