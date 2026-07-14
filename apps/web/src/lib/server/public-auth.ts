import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { expo } from "@better-auth/expo";
import { betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import { username } from "better-auth/plugins/username";
import * as schema from "../../db/schema";
import { getDb, getDrizzleDb, typedRow } from "./db";
import { jsonError, readOptionalEnv } from "./env";
import { sendPasswordResetEmail } from "./resend";

// The CLI's OAuth client id for the device-authorization grant (RFC 8628). The
// `fluncle login` flow is a first-party, fully-trusted client — the CLI is ours,
// it carries no client secret, and the device code is bound to the approving
// user — so it is the only id we accept (`validateClient` below). The minted
// access_token is a NORMAL better-auth session token (the same carrier the web
// cookie wraps), resolved by the `bearer` plugin, and is HARD-SEPARATE from the
// admin `FLUNCLE_API_TOKEN` grant (which `adminRole` in ./env.ts resolves by a
// constant-time compare — a user session token can never match it).
export const cliDeviceClientId = "fluncle-cli";

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

// Exported as a test seam: the device-auth suite builds a fresh, isolated auth
// instance per test over an in-memory drizzle DB by passing it here, sidestepping
// the module-level `getPublicAuth` memo. Production builds it once via `getPublicAuth`.
export function createPublicAuthOptions(
  db: Awaited<ReturnType<typeof getDrizzleDb>>,
): BetterAuthOptions {
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
      // The password-reset rail (web + mobile). Better Auth builds the tokenised
      // `url` (it validates the token then redirects to the `/reset-password` page
      // with the token in the query); we just deliver it. The token rides the
      // existing `verification` table — no schema change. A Resend fault is caught
      // and logged rather than rethrown, so the `/request-password-reset` response
      // is uniform whether or not delivery succeeded — keeping it
      // email-enumeration-safe (Better Auth already returns the same shape whether
      // or not the address is on an account).
      sendResetPassword: async ({ url, user }) => {
        try {
          await sendPasswordResetEmail({ to: user.email, url });
        } catch (error) {
          console.error("password reset email failed to send", error);
        }
      },
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
      // The OAuth 2.0 Device Authorization Grant (RFC 8628) — the framework-native
      // engine behind `fluncle login`. The CLI requests a device+user code, the
      // user approves at /device while signed in to their Fluncle account, and the
      // CLI polls /api/auth/device/token to receive a session token. The verification
      // surface is the `/device` route in this app.
      deviceAuthorization({
        expiresIn: "30m",
        interval: "5s",
        // No model/field overrides — the drizzle adapter maps the `deviceCode`
        // model to our `device_code` table via the schema object above. The key
        // must still be present: this plugin version's options schema treats
        // `schema` as non-optional.
        schema: {},
        // First-party CLI only: the `fluncle-cli` client carries no secret and the
        // device code is user-bound, so the id IS the trust boundary here.
        validateClient: (clientId) => clientId === cliDeviceClientId,
      }),
      // Accept the device-minted session token as `Authorization: Bearer <token>`
      // so the CLI (which has no cookie jar) can call `/me` reads. This resolves a
      // USER session only; it never touches the admin grant — `adminRole`
      // (./env.ts) compares the Bearer against `FLUNCLE_API_TOKEN`/`FLUNCLE_AGENT_TOKEN`
      // by constant-time equality, which a random session token cannot satisfy.
      bearer(),
      // The Expo native-client handshake for the mobile app. It only adds handling
      // for requests carrying the `fluncle://` origin (the app scheme, allow-listed
      // in `trustedOrigins` below) — cookie/session behaviour for browser clients is
      // byte-for-byte unchanged. It lets the app complete the OAuth/deep-link round
      // trip and read the session token from the response header (no cookie jar on
      // native), the mobile analogue of the CLI's `bearer` path.
      expo(),
    ],
    secret: publicAuthSecret(),
    // The app scheme (`fluncle://`) is trusted so the Expo plugin accepts the native
    // client's deep-link origin; the web origins are unchanged.
    trustedOrigins: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://www.fluncle.com",
      "fluncle://",
    ],
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

  if (received === undefined) {
    return false;
  }

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
