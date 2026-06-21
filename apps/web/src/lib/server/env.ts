import { createHmac, timingSafeEqual } from "node:crypto";

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
  // ElevenLabs TTS for the audio-observation render (Worker-side; the agent never
  // holds it). ELEVENLABS_API_KEY is a secret; ELEVENLABS_VOICE_ID is a swappable
  // config var (a stock library voice today; the bespoke Fluncle voice drops in by
  // swapping it). The voice id is read via readOptionalEnv so a missing one is a
  // clean 400, not a thrown Missing.
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
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
  "LOOPS_API_KEY",
  "LOOPS_TRANSACTIONAL_ID",
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
  // Our own YouTube OAuth (mixtape video distribution), mirroring Spotify. The
  // Worker holds the durable refresh token in youtube_auth and mints a short-lived
  // access token for the CLI's resumable upload PUT.
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_REDIRECT_URI",
  // Our own Mixcloud OAuth (mixtape audio distribution). The Worker runs the code
  // exchange + stores the durable token in mixcloud_auth, then hands it to the CLI
  // just-in-time for the CLI-direct upload (the bytes are CLI-direct; the token is
  // not — the CLI stays a thin client). No redirect-URI var: Mixcloud takes it at
  // runtime, so it's derived from the request origin (mixcloudRedirectUri).
  "MIXCLOUD_CLIENT_ID",
  "MIXCLOUD_CLIENT_SECRET",
  // Last.fm write side (love-on-add). API_KEY + SHARED_SECRET come from the
  // Last.fm API application; SESSION_KEY (durable, non-expiring) comes from
  // running `fluncle admin auth lastfm`. All three are Worker secrets. The love
  // hook no-ops when SESSION_KEY is absent, so the publish path works unprovisioned.
  "LASTFM_API_KEY",
  "LASTFM_SHARED_SECRET",
  "LASTFM_SESSION_KEY",
  // Discogs read-only release-ID enrichment (lib/server/discogs.ts): a personal
  // access token created in the `fluncle` Discogs developer settings. It lifts the
  // rate limit to ~60 req/min and is read via readOptionalEnv, so the lookup
  // no-ops (in_release_id/in_master_id stay inert) until the secret is set.
  "DISCOGS_USER_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHANNEL_ID",
  "DISCORD_WEBHOOK_URL",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  // Spinup agents: each has its own scoped runtime key (sk_agent_…) + id. Async
  // track enrichment fires on add via runs.create.
  "SPINUP_ENRICH_AGENT_ID",
  "SPINUP_ENRICH_AGENT_KEY",
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
  // (lib/server/push.ts; docs/rfcs/mobile-app.md §7). OPTIONAL and read via
  // readOptionalEnv: the whole push feature is a NO-OP until this is set — the
  // send-on-publish side-channel returns immediately, so the publish path works
  // unprovisioned exactly like the Last.fm/Telegram hooks. With Expo's "Enhanced
  // Security for Push" enabled this Bearer is REQUIRED for /send to authorize.
  "EXPO_ACCESS_TOKEN",
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

// One admin identity, two carriers (see docs/admin-tagging.md): the CLI/agent
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

// Two admin ROLES, not one admin with carriers (see docs/agents/hermes-agent.md):
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

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
