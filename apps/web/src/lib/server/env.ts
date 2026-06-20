import { createHmac, timingSafeEqual } from "node:crypto";

let didLoadLocalEnv = false;

const envKeys = [
  // Admin "Login with Spotify" allow-list — the operator identity, kept out of
  // this public repo. ADMIN_ALLOWED_EMAILS is required; ADMIN_ALLOWED_SPOTIFY_IDS
  // is optional. Both are comma-separated (see admin-auth.ts).
  "ADMIN_ALLOWED_EMAILS",
  "ADMIN_ALLOWED_SPOTIFY_IDS",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "FIRECRAWL_API_KEY",
  "FLUNCLE_API_TOKEN",
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
// send the token as a Bearer header; the browser sends a signed grant COOKIE
// (the token is the signing key, never the transported value — admin-auth.ts).
// requireAdmin accepts either, so every existing /api/admin/* route is reachable
// from the browser tagging UI without forking per-carrier logic.
export const ADMIN_COOKIE_NAME = "fluncle_admin";
// The browser session window. Deliberately NOT the OAuth state window: a 10-min
// cookie would log the single operator out mid-session.
export const ADMIN_GRANT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

export async function requireAdmin(request: Request): Promise<Response | undefined> {
  const expectedToken = await readEnv("FLUNCLE_API_TOKEN");
  const header = request.headers.get("Authorization");
  const prefix = "Bearer ";

  if (header?.startsWith(prefix) && constantTimeEqual(header.slice(prefix.length), expectedToken)) {
    return undefined;
  }

  if (await hasValidAdminCookie(request)) {
    return undefined;
  }

  return unauthorized();
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
  const token = await readEnv("FLUNCLE_API_TOKEN");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", token).update(body).digest("base64url");

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
  const token = await readEnv("FLUNCLE_API_TOKEN");
  const [body, signature] = state.split(".");

  if (!body || !signature) {
    throw new Error("Invalid state");
  }

  const expected = createHmac("sha256", token).update(body).digest("base64url");

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

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
