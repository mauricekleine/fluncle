import { createHmac, timingSafeEqual } from "node:crypto";

export type FetchImpl = typeof fetch;

let didLoadLocalEnv = false;

const envKeys = [
  "ADMIN_ALLOWED_EMAILS",
  "ADMIN_ALLOWED_SPOTIFY_IDS",

  "ADMIN_SESSION_SECRET",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",

  "CARTESIA_API_KEY",
  "CARTESIA_VOICE_ID",
  "FIRECRAWL_API_KEY",

  "FLUNCLE_BACKFILL_BEATPORT_CATALOGUE_LIMIT",
  "FLUNCLE_API_TOKEN",

  "FLUNCLE_AGENT_TOKEN",

  "RESEND_API_KEY",
  "RESEND_SEGMENT_ID",
  "RESEND_FROM",
  "RESEND_API_URL",
  "POSTIZ_API_KEY",
  "POSTIZ_API_URL",

  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",

  "R2_ACCOUNT_ID",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_REDIRECT_URI",
  "SPOTIFY_PLAYLIST_ID",

  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",

  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_REDIRECT_URI",

  "YOUTUBE_API_KEY",

  "MIXCLOUD_CLIENT_ID",
  "MIXCLOUD_CLIENT_SECRET",

  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",

  "TIKTOK_CLIENT_KEY",
  "TIKTOK_CLIENT_SECRET",
  "TIKTOK_REDIRECT_URI",

  "GITHUB_TOKEN",
  "INSTAGRAM_CLIENT_ID",
  "INSTAGRAM_CLIENT_SECRET",

  "LASTFM_API_KEY",
  "LASTFM_SHARED_SECRET",
  "LASTFM_SESSION_KEY",

  "APPLE_MUSIC_TEAM_ID",
  "APPLE_MUSIC_KEY_ID",
  "APPLE_MUSIC_PRIVATE_KEY",

  "DISCOGS_USER_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHANNEL_ID",
  "DISCORD_WEBHOOK_URL",

  "DISCORD_ALERT_WEBHOOK",

  "BLUESKY_IDENTIFIER",
  "BLUESKY_APP_PASSWORD",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",

  "DEVICE_REPLICA_DB_URL",
  "DEVICE_REPLICA_DB_NAME",
  "TURSO_PLATFORM_ORG",
  "TURSO_PLATFORM_TOKEN",

  "TURSO_TELEMETRY_DATABASE_URL",
  "TURSO_TELEMETRY_AUTH_TOKEN",

  "CF_CACHE_PURGE_ZONE_ID",
  "CF_CACHE_PURGE_TOKEN",

  "EXPO_ACCESS_TOKEN",

  "OPENROUTER_API_KEY",
  "OPENROUTER_CONTEXT_MODEL",

  "OPENROUTER_CONTEXT_EFFORT",

  "OPENROUTER_SEARCH_MODEL",

  "OPENROUTER_REASONING_EFFORT",

  "SIMPLE_ANALYTICS_API_KEY",

  "OPENROUTER_CHAT_MODEL",
  "FLUNCLE_E2E",
  "SEARCH_ARCHIVE_RATE_LIMIT",
  "SONAR_BASE_URL",
  "SONAR_SECRET",
] as const;

export type EnvKey = (typeof envKeys)[number];

export async function loadLocalEnv(options: { force?: boolean } = {}): Promise<void> {
  if ((!import.meta.env.DEV && !options.force) || didLoadLocalEnv) {
    return;
  }

  if (process.env.VITEST) {
    didLoadLocalEnv = true;

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

export const ADMIN_COOKIE_NAME = "fluncle_admin";

export const ADMIN_GRANT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

export const OAUTH_HANDOFF_MAX_AGE_MS = 10 * 60 * 1000;

export const ADMIN_GRANT_EPOCH_KEY = "admin_grant_epoch";

async function readGrantEpoch(): Promise<number> {
  const { getSetting } = await import("./settings");
  const raw = await getSetting(ADMIN_GRANT_EPOCH_KEY);

  if (raw === undefined) {
    return 0;
  }

  const trimmed = raw.trim();
  const parsed = Number(trimmed);

  if (!trimmed || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Malformed ${ADMIN_GRANT_EPOCH_KEY}`);
  }

  return parsed;
}

export async function currentGrantEpoch(): Promise<number> {
  return readGrantEpoch();
}

export async function revokeAdminGrants(): Promise<number> {
  const { setSetting } = await import("./settings");
  const next = await readGrantEpoch().then(
    (epoch) => epoch + 1,
    () => Math.floor(Date.now() / 1000),
  );

  await setSetting(ADMIN_GRANT_EPOCH_KEY, String(next));

  return next;
}

export type AdminRole = "operator" | "agent";

export async function adminRole(request: Request): Promise<AdminRole | null> {
  const header = request.headers.get("Authorization");
  const prefix = "Bearer ";
  const token = header?.startsWith(prefix) ? header.slice(prefix.length) : undefined;

  if (token) {
    const operatorToken = await readOptionalEnv("FLUNCLE_API_TOKEN");

    if (operatorToken && constantTimeEqual(token, operatorToken)) {
      return "operator";
    }

    const agentToken = await readOptionalEnv("FLUNCLE_AGENT_TOKEN");

    if (agentToken && constantTimeEqual(token, agentToken)) {
      return "agent";
    }
  }

  if (await hasValidAdminCookie(request)) {
    return "operator";
  }

  return null;
}

const STATE_CHANGING_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);

export function hasBearerHeader(request: Request): boolean {
  return request.headers.get("Authorization")?.startsWith("Bearer ") ?? false;
}

export function requireAdminMutationOrigin(request: Request): Response | undefined {
  if (!STATE_CHANGING_METHODS.has(request.method.toUpperCase()) || hasBearerHeader(request)) {
    return undefined;
  }

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const requestOrigin = new URL(request.url).origin;

  if (origin) {
    return origin === requestOrigin
      ? undefined
      : jsonError(403, "invalid_origin", "Invalid request origin");
  }

  if (!referer) {
    return jsonError(403, "invalid_origin", "Missing request origin");
  }

  try {
    return new URL(referer).origin === requestOrigin
      ? undefined
      : jsonError(403, "invalid_origin", "Invalid request origin");
  } catch {
    return jsonError(403, "invalid_origin", "Invalid request origin");
  }
}

export async function requireAdmin(request: Request): Promise<Response | undefined> {
  return (await adminRole(request)) ? undefined : unauthorized();
}

export async function requireOperator(request: Request): Promise<Response | undefined> {
  const role = await adminRole(request);

  if (role === "operator") {
    return undefined;
  }

  return role === "agent" ? forbidden() : unauthorized();
}

async function hasValidAdminCookie(request: Request): Promise<boolean> {
  return verifyAdminGrant(readCookie(request.headers.get("cookie"), ADMIN_COOKIE_NAME));
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) {
    return undefined;
  }

  for (const part of header.split(/;\s*/)) {
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

const GRANT_KEY_LABEL = "fluncle/admin-grant-cookie/v1";
const OAUTH_STATE_KEY_LABEL = "fluncle/oauth-state/v1";

const OAUTH_HANDOFF_KEY_LABEL = "fluncle/oauth-handoff/v1";

async function signingSubkey(label: string): Promise<Buffer> {
  const root = await readEnv("ADMIN_SESSION_SECRET");

  return createHmac("sha256", root).update(label).digest();
}

function signWithKey(key: Buffer, payload: Record<string, string | number>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", key).update(body).digest("base64url");

  return `${body}.${signature}`;
}

function verifyWithKey(key: Buffer, state: string, maxAgeMs: number): Record<string, unknown> {
  const [body, signature] = state.split(".");

  if (!body || !signature) {
    throw new Error("Invalid state");
  }

  const expected = createHmac("sha256", key).update(body).digest("base64url");

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

export async function signOauthState(payload: Record<string, string | number>): Promise<string> {
  return signWithKey(await signingSubkey(OAUTH_STATE_KEY_LABEL), payload);
}

export async function verifyState(state: string): Promise<Record<string, unknown>> {
  return verifyWithKey(await signingSubkey(OAUTH_STATE_KEY_LABEL), state, OAUTH_STATE_MAX_AGE_MS);
}

export async function signOauthHandoff(payload: Record<string, string | number>): Promise<string> {
  return signWithKey(await signingSubkey(OAUTH_HANDOFF_KEY_LABEL), payload);
}

export async function verifyOauthHandoff(token: string): Promise<Record<string, unknown>> {
  return verifyWithKey(
    await signingSubkey(OAUTH_HANDOFF_KEY_LABEL),
    token,
    OAUTH_HANDOFF_MAX_AGE_MS,
  );
}

export async function signAdminGrant(): Promise<string> {
  const [key, epoch] = await Promise.all([signingSubkey(GRANT_KEY_LABEL), currentGrantEpoch()]);

  return signWithKey(key, { epoch, iat: Date.now(), role: "admin" });
}

export async function verifyAdminGrant(value: string | null | undefined): Promise<boolean> {
  if (!value) {
    return false;
  }

  try {
    const payload = verifyWithKey(
      await signingSubkey(GRANT_KEY_LABEL),
      value,
      ADMIN_GRANT_MAX_AGE_MS,
    );

    if (payload.role !== "admin") {
      return false;
    }

    if (typeof payload.epoch !== "number" || !Number.isInteger(payload.epoch)) {
      return false;
    }

    return payload.epoch >= (await currentGrantEpoch());
  } catch {
    return false;
  }
}

function unauthorized(): Response {
  return jsonError(401, "unauthorized", "Missing or invalid admin token");
}

function forbidden(): Response {
  return jsonError(403, "forbidden", "This action requires the operator role");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
