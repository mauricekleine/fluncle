import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { username } from "better-auth/plugins/username";
import * as schema from "../../db/schema";
import { getDb, getDrizzleDb, typedRow } from "./db";
import { jsonError, readOptionalEnv } from "./env";

type PublicAuth = Auth<BetterAuthOptions>;

export type PublicUser = {
  createdAt: string;
  displayUsername?: string;
  id: string;
  username?: string;
};

type PublicUserRow = {
  created_at: number;
  display_username: string | null;
  id: string;
  status: "active" | "deleted" | "suspended";
  username: string | null;
};

let publicAuthPromise: Promise<PublicAuth> | undefined;
const devAuthSecret = "fluncle-dev-auth-secret-change-before-production";
const csrfHeaderName = "x-fluncle-csrf";
const csrfWindowMs = 24 * 60 * 60 * 1000;

const reservedUsernames = new Set([
  "account",
  "admin",
  "api",
  "auth",
  "cli",
  "fluncle",
  "galaxy",
  "log",
  "mcp",
  "rss",
  "spotify",
  "support",
  "www",
]);

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function isAllowedUsername(value: string): boolean {
  const username = normalizeUsername(value);

  return (
    /^[a-z0-9_]{3,24}$/.test(username) &&
    !username.startsWith("_") &&
    !username.endsWith("_") &&
    !username.includes("__") &&
    !reservedUsernames.has(username)
  );
}

export function isAllowedDisplayUsername(value: string): boolean {
  const trimmed = value.trim();

  return trimmed.length >= 3 && trimmed.length <= 32 && /^[A-Za-z0-9_ .-]+$/.test(trimmed);
}

export function resolvePublicAuthSecret(secret: string | undefined, isDev: boolean): string {
  if (secret?.trim()) {
    return secret;
  }

  if (isDev) {
    return devAuthSecret;
  }

  throw new Error("BETTER_AUTH_SECRET is required outside local development");
}

function publicAuthSecret(): string {
  return resolvePublicAuthSecret(process.env.BETTER_AUTH_SECRET, import.meta.env.DEV);
}

function createPublicAuthOptions(db: Awaited<ReturnType<typeof getDrizzleDb>>): BetterAuthOptions {
  return {
    advanced: {
      cookiePrefix: "fluncle_user",
    },
    basePath: "/api/auth",
    baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
      maxPasswordLength: 128,
      minPasswordLength: 10,
    },
    plugins: [
      username({
        displayUsernameValidator: isAllowedDisplayUsername,
        maxUsernameLength: 24,
        minUsernameLength: 3,
        usernameNormalization: normalizeUsername,
        usernameValidator: isAllowedUsername,
        validationOrder: {
          displayUsername: "post-normalization",
          username: "post-normalization",
        },
      }),
    ],
    secret: publicAuthSecret(),
    trustedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000", "https://www.fluncle.com"],
    user: {
      additionalFields: {
        deletedAt: { required: false, returned: false, type: "number" },
        lastSeenAt: { required: false, returned: false, type: "number" },
        status: { defaultValue: "active", required: false, returned: false, type: "string" },
      },
    },
  };
}

export async function getPublicAuth(): Promise<PublicAuth> {
  if (!publicAuthPromise) {
    publicAuthPromise = (async () => {
      process.env.BETTER_AUTH_SECRET ??= await readOptionalEnv("BETTER_AUTH_SECRET");
      process.env.BETTER_AUTH_URL ??= await readOptionalEnv("BETTER_AUTH_URL");

      return betterAuth(createPublicAuthOptions(await getDrizzleDb()));
    })();
  }

  return publicAuthPromise;
}

export async function getPublicSession(request: Request): Promise<PublicUser | undefined> {
  const auth = await getPublicAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  const sessionUser = session?.user as
    | {
        id: string;
      }
    | undefined;

  if (!sessionUser) {
    return undefined;
  }

  const result = await (
    await getDb()
  ).execute({
    args: [sessionUser.id],
    sql: `select id, username, display_username, created_at, status from "user" where id = ? limit 1`,
  });
  const user = typedRow<PublicUserRow>(result.rows);

  if (!user || user.status !== "active") {
    return undefined;
  }

  return {
    createdAt: new Date(user.created_at).toISOString(),
    displayUsername: user.display_username ?? undefined,
    id: user.id,
    username: user.username ?? undefined,
  };
}

export async function requirePublicUser(request: Request): Promise<PublicUser | Response> {
  const user = await getPublicSession(request);

  return user ?? jsonError(401, "auth_required", "Sign in to use this private account route");
}

export function createCsrfToken(user: PublicUser, now = Date.now()): string {
  const bucket = Math.floor(now / csrfWindowMs);
  const body = `${user.id}.${bucket}`;
  const signature = createHmac("sha256", publicAuthSecret()).update(body).digest("base64url");

  return `${body}.${signature}`;
}

function verifyCsrfToken(user: PublicUser, token: string | null): boolean {
  if (!token) {
    return false;
  }

  const parts = token.split(".");

  if (parts.length !== 3 || parts[0] !== user.id) {
    return false;
  }

  const bucket = Number(parts[1]);
  const currentBucket = Math.floor(Date.now() / csrfWindowMs);

  if (!Number.isInteger(bucket) || bucket < currentBucket - 1 || bucket > currentBucket) {
    return false;
  }

  const expected = createHmac("sha256", publicAuthSecret())
    .update(`${parts[0]}.${parts[1]}`)
    .digest("base64url");
  const received = parts[2];

  try {
    return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function requireJsonMutation(request: Request, user: PublicUser): Response | undefined {
  const method = request.method.toUpperCase();

  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return undefined;
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.toLowerCase().includes("application/json")) {
    return jsonError(415, "invalid_content_type", "Expected application/json");
  }

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const requestOrigin = new URL(request.url).origin;

  if (!origin && !referer) {
    return jsonError(403, "invalid_origin", "Missing request origin");
  }

  if (origin && origin !== requestOrigin) {
    return jsonError(403, "invalid_origin", "Invalid request origin");
  }

  if (!origin && referer) {
    try {
      if (new URL(referer).origin !== requestOrigin) {
        return jsonError(403, "invalid_origin", "Invalid request origin");
      }
    } catch {
      return jsonError(403, "invalid_origin", "Invalid request origin");
    }
  }

  if (!verifyCsrfToken(user, request.headers.get(csrfHeaderName))) {
    return jsonError(403, "csrf_required", "Invalid account mutation token");
  }

  return undefined;
}

export function hashRequestPart(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();

  return normalized ? createHash("sha256").update(normalized).digest("hex") : undefined;
}
