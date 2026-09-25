import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { waitUntil } from "cloudflare:workers";
import { expo } from "@better-auth/expo";
import { betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, deviceAuthorization, magicLink } from "better-auth/plugins";
import { username } from "better-auth/plugins/username";
import { type PublicUser } from "@fluncle/contracts";
import * as schema from "../../db/schema";
import { getDb, getDrizzleDb, typedRow } from "./db";
import { notifyDiscordSignup } from "./discord-alert";
import { attachFollowIntent, parseFollowTarget, signFollowIntent } from "./follow-intent";
import { resolveFollowTarget } from "./follow-targets";
import { jsonError, readOptionalEnv } from "./env";
import { sendMagicLinkEmail, sendPasswordResetEmail, sendVerificationEmail } from "./resend";

export const cliDeviceClientId = "fluncle-cli";

type PublicAuth = Auth<BetterAuthOptions>;

export type { PublicUser };

type PublicUserRow = {
  created_at: number;
  crew_number: number | null;
  display_username: string | null;
  email: string | null;
  email_verified: number;
  id: string;
  image: string | null;
  last_seen_at: number | null;
  name: string | null;
  status: "active" | "deleted" | "suspended";
  username: string | null;
};

let publicAuthPromise: Promise<PublicAuth> | undefined;
const devAuthSecret = "fluncle-dev-auth-secret-change-before-production";

const devAuthBaseUrl = "http://localhost:3000";
const csrfHeaderName = "x-fluncle-csrf";
const csrfWindowMs = 24 * 60 * 60 * 1000;

export const MAGIC_LINK_TTL_SECONDS = 15 * 60;

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

export function publicAuthSecret(): string {
  return resolvePublicAuthSecret(process.env.BETTER_AUTH_SECRET, import.meta.env.DEV);
}

export function resolvePublicAuthBaseUrl(url: string | undefined, isDev: boolean): string {
  const trimmed = url?.trim();

  if (trimmed) {
    return trimmed;
  }

  if (isDev) {
    return devAuthBaseUrl;
  }

  throw new Error("BETTER_AUTH_URL is required outside local development");
}

type DbClient = Awaited<ReturnType<typeof getDb>>;
type CrewNumberRow = { crew_number: number };

export async function assignCrewNumber(
  userId: string,
  client?: DbClient,
): Promise<number | undefined> {
  const db = client ?? (await getDb());
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await db.execute({
        args: [userId],
        sql: `update "user"
          set crew_number = (select coalesce(max(crew_number), 0) + 1 from "user")
          where id = ? and crew_number is null
          returning crew_number`,
      });

      return typedRow<CrewNumberRow>(result.rows)?.crew_number;
    } catch (error) {
      if (attempt < maxAttempts && isUniqueViolation(error)) {
        continue;
      }

      throw error;
    }
  }

  return undefined;
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return message.toUpperCase().includes("UNIQUE CONSTRAINT");
}

async function autoSubscribeAtSignup(email: string, ctx: unknown): Promise<void> {
  try {
    const { subscribeToNewsletter } = await import("./newsletter");

    await subscribeToNewsletter({ email }, requestFromHookContext(ctx));
  } catch (error) {
    console.error("auto-subscribe at sign-up failed", error);
  }
}

function requestFromHookContext(ctx: unknown): Request {
  const maybe = ctx as { headers?: HeadersInit; request?: unknown } | null;

  if (maybe?.request instanceof Request) {
    return maybe.request;
  }

  return new Request("https://www.fluncle.com/internal/signup-subscribe", {
    headers: maybe?.headers,
  });
}

export async function withFollowIntent({
  email,
  metadata,
  url,
}: {
  email: string;
  metadata?: Record<string, unknown>;
  url: string;
}): Promise<{ followName?: string; url: string }> {
  const requested = parseFollowTarget(metadata?.follow);

  if (!requested) {
    return { url };
  }

  try {
    const target = await resolveFollowTarget(requested);

    if (!target) {
      return { url };
    }

    const intent = signFollowIntent({ email, secret: publicAuthSecret(), target });
    const baseUrl = resolvePublicAuthBaseUrl(process.env.BETTER_AUTH_URL, import.meta.env.DEV);

    return {
      followName: target.name,
      url: attachFollowIntent({ baseUrl, intent, magicLinkUrl: url }),
    };
  } catch (error) {
    console.error("follow intent could not be attached to the sign-in link", error);

    return { url };
  }
}

export function createPublicAuthOptions(
  db: Awaited<ReturnType<typeof getDrizzleDb>>,
): BetterAuthOptions {
  const googleProvider = readGoogleProvider();

  return {
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
      },
    },
    advanced: {
      cookiePrefix: "fluncle_user",
    },
    basePath: "/api/auth",
    baseURL: resolvePublicAuthBaseUrl(process.env.BETTER_AUTH_URL, import.meta.env.DEV),
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
    }),

    databaseHooks: {
      user: {
        create: {
          after: async (createdUser, hookContext) => {
            let crewNumber: number | undefined;

            try {
              crewNumber = await assignCrewNumber(createdUser.id);
            } catch (error) {
              console.error("crew-number assignment failed", error);
            }

            await Promise.all([
              autoSubscribeAtSignup(createdUser.email, hookContext),
              notifyDiscordSignup({ crewNumber }).catch((error: unknown) => {
                console.error("Discord signup alert failed", error);
              }),
            ]);
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      maxPasswordLength: 128,
      minPasswordLength: 10,

      sendResetPassword: async ({ url, user }) => {
        try {
          await sendPasswordResetEmail({ to: user.email, url });
        } catch (error) {
          console.error("password reset email failed to send", error);
        }
      },
    },

    emailVerification: {
      autoSignInAfterVerification: true,
      sendOnSignUp: true,
      sendVerificationEmail: async ({ url, user }) => {
        try {
          await sendVerificationEmail({ to: user.email, url });
        } catch (error) {
          console.error("verification email failed to send", error);
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

      deviceAuthorization({
        expiresIn: "30m",
        interval: "5s",

        schema: {},

        validateClient: (clientId) => clientId === cliDeviceClientId,
      }),

      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        sendMagicLink: async ({ email, metadata, url }) => {
          await sendMagicLinkEmail({
            to: email,
            ...(await withFollowIntent({ email, metadata, url })),
          });
        },
        storeToken: "hashed",
      }),

      bearer(),

      expo(),
    ],
    secret: publicAuthSecret(),

    session: {
      cookieCache: {
        enabled: true,
        maxAge: 60,
      },
    },

    ...(googleProvider ? { socialProviders: { google: googleProvider } } : {}),

    trustedOrigins: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://fluncle.com",
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

function readGoogleProvider(): { clientId: string; clientSecret: string } | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();

  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

export async function isGoogleSignInEnabled(): Promise<boolean> {
  const [clientId, clientSecret] = await Promise.all([
    readOptionalEnv("GOOGLE_CLIENT_ID"),
    readOptionalEnv("GOOGLE_CLIENT_SECRET"),
  ]);

  return Boolean(clientId && clientSecret);
}

export async function getPublicAuth(): Promise<PublicAuth> {
  if (!publicAuthPromise) {
    publicAuthPromise = (async () => {
      process.env.BETTER_AUTH_SECRET ??= await readOptionalEnv("BETTER_AUTH_SECRET");
      process.env.BETTER_AUTH_URL ??= await readOptionalEnv("BETTER_AUTH_URL");

      const googleClientId = await readOptionalEnv("GOOGLE_CLIENT_ID");
      const googleClientSecret = await readOptionalEnv("GOOGLE_CLIENT_SECRET");

      if (googleClientId) {
        process.env.GOOGLE_CLIENT_ID = googleClientId;
      }

      if (googleClientSecret) {
        process.env.GOOGLE_CLIENT_SECRET = googleClientSecret;
      }

      return betterAuth(createPublicAuthOptions(await getDrizzleDb()));
    })();
  }

  return publicAuthPromise;
}

export const LAST_SEEN_BUMP_MS = 60 * 60 * 1000;

export function shouldBumpLastSeen(lastSeenMs: number | null, now: number): boolean {
  return lastSeenMs == null || now - lastSeenMs > LAST_SEEN_BUMP_MS;
}

async function bumpLastSeen(userId: string): Promise<void> {
  try {
    await (
      await getDb()
    ).execute({
      args: [Date.now(), userId],
      sql: `update "user" set last_seen_at = ? where id = ?`,
    });
  } catch {}
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
    sql: `select id, username, display_username, name, image, created_at, status, email, email_verified, crew_number, last_seen_at from "user" where id = ? limit 1`,
  });
  const user = typedRow<PublicUserRow>(result.rows);

  if (!user || user.status !== "active") {
    return undefined;
  }

  if (shouldBumpLastSeen(user.last_seen_at, Date.now())) {
    const bump = bumpLastSeen(user.id);

    try {
      waitUntil(bump);
    } catch {
      bump.catch(() => undefined);
    }
  }

  return {
    createdAt: new Date(user.created_at).toISOString(),
    crewNumber: user.crew_number ?? undefined,
    displayUsername: user.display_username ?? undefined,
    email: user.email ?? "",
    emailVerified: user.email_verified === 1,
    id: user.id,
    image: user.image ?? undefined,
    name: user.name ?? "",
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
