import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { expo } from "@better-auth/expo";
import { betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import { username } from "better-auth/plugins/username";
import * as schema from "../../db/schema";
import { getDb, getDrizzleDb, typedRow } from "./db";
import { jsonError, readOptionalEnv } from "./env";
import { sendPasswordResetEmail, sendVerificationEmail } from "./resend";

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
  // The account's enlistment ordinal — its place on the crew manifest (the
  // account-redesign brief, ruling #1). Stamped once at sign-up by the
  // `user.create.after` hook and fixed for life. OPTIONAL: a legacy account created
  // before the crew number existed carries none until the one-time backfill runs, so
  // every reader must treat its absence as "unstamped", never zero.
  crewNumber?: number;
  displayUsername?: string;
  // The account's own email. This is the AUTHENTICATED identity — a `PublicUser` is
  // only ever resolved from the requester's OWN session (the `/me` private tier), so
  // this is always the requester's own address, never another user's. It powers the
  // Settings "Email" section + the "resend verification" action, and rides the data
  // export. The DESIGN invariant "email never appears on PUBLIC surfaces" is upheld:
  // no public route serializes a `PublicUser`.
  email: string;
  // Whether this account's email is verified. Always present (the `user` row's
  // `email_verified` is NOT NULL, default false). Verification GATES future
  // features, never the session — an unverified user still signs in (see
  // `emailVerification` below, which deliberately omits `requireEmailVerification`).
  emailVerified: boolean;
  id: string;
  // The avatar URL when the account has one (Google fills it at sign-up; an
  // upload path is a future slice). Absent = render the glyph fallback.
  image?: string;
  // The freeform display name (the "Name" in Settings — what Google fills at
  // sign-up and what the header shows). Distinct from `username` (the handle) and
  // `displayUsername` (the handle's as-typed casing).
  name: string;
  username?: string;
};

type PublicUserRow = {
  created_at: number;
  crew_number: number | null;
  display_username: string | null;
  email: string | null;
  email_verified: number;
  id: string;
  image: string | null;
  name: string | null;
  status: "active" | "deleted" | "suspended";
  username: string | null;
};

let publicAuthPromise: Promise<PublicAuth> | undefined;
const devAuthSecret = "fluncle-dev-auth-secret-change-before-production";
const csrfHeaderName = "x-fluncle-csrf";
const csrfWindowMs = 24 * 60 * 60 * 1000;

// Handles a user may never claim, because each collides with a top-level route
// segment. NOTE on the coming `/crew/<username>` public-profile namespace (the
// account-redesign brief, ruling #1): it does NOT need an entry here. Reserved
// usernames guard the HANDLE, and `/crew/<username>` USES the handle as its slug —
// the profile lives one segment DOWN from `/crew`, so no handle can shadow it and
// nothing needs reserving. The crew NUMBER rides that profile; it is not a handle.
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

type DbClient = Awaited<ReturnType<typeof getDb>>;
type CrewNumberRow = { crew_number: number };

/**
 * Stamp the account's crew number — its enlistment ordinal on the manifest (the
 * account-redesign brief, ruling #1) — as `max(crew_number) + 1`, atomically.
 *
 * CONCURRENCY. The whole assignment is ONE `UPDATE … SET crew_number = (SELECT
 * MAX + 1)` statement. libSQL/Turso serializes writers (docs/local-database.md), so
 * two simultaneous sign-ups can never both read the same MAX: the first commits N+1,
 * the second's sub-select then sees N+1 and commits N+2. The `UNIQUE` index is the
 * backstop — should any layer ever race the sub-select, the loser hits a UNIQUE
 * violation and this retries (recomputing MAX) up to `maxAttempts`.
 *
 * IDEMPOTENT. `WHERE crew_number IS NULL` leaves an already-numbered row untouched
 * (0 rows updated ⇒ returns `undefined`), so a re-run — or the backfill visiting an
 * already-stamped user — is a safe no-op.
 *
 * Returns the number it assigned, or `undefined` when the user already had one (or
 * the row is gone). Accepts an explicit client so a test (and the backfill) can drive
 * it against a chosen DB; production passes none and it uses `getDb()`.
 */
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

/** True when a libSQL error is a UNIQUE-constraint violation (the crew-number race backstop). */
function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return message.toUpperCase().includes("UNIQUE CONSTRAINT");
}

/**
 * Best-effort newsletter subscribe for a brand-new account (the account-redesign
 * brief, ruling #5): signing up puts your email on the Friday newsletter. Reuses the
 * public `subscribeToNewsletter` path (validation + the shared rate limiter + the
 * Resend segment write), imported DYNAMICALLY so the module graph stays acyclic
 * (`newsletter` already imports from here).
 *
 * A fault here NEVER fails the sign-up — a missing Resend env, a Resend outage, or a
 * rate-limit throw is caught and logged, exactly like `sendResetPassword` /
 * `sendVerificationEmail` below. The account is created either way.
 */
async function autoSubscribeAtSignup(email: string, ctx: unknown): Promise<void> {
  try {
    const { subscribeToNewsletter } = await import("./newsletter");

    await subscribeToNewsletter({ email }, requestFromHookContext(ctx));
  } catch (error) {
    console.error("auto-subscribe at sign-up failed", error);
  }
}

/**
 * The `Request` a better-auth database hook's context carries (the sign-up request —
 * POST for email/password, the OAuth callback GET for social), used for the newsletter
 * rate-limit bucket. The typed `GenericEndpointContext` under-declares the runtime
 * context, so read it defensively and fall back to a synthetic request when a creation
 * has no endpoint context (never at a real sign-up).
 */
function requestFromHookContext(ctx: unknown): Request {
  const maybe = ctx as { headers?: HeadersInit; request?: unknown } | null;

  if (maybe?.request instanceof Request) {
    return maybe.request;
  }

  return new Request("https://www.fluncle.com/internal/signup-subscribe", {
    headers: maybe?.headers,
  });
}

// Exported as a test seam: the device-auth suite builds a fresh, isolated auth
// instance per test over an in-memory drizzle DB by passing it here, sidestepping
// the module-level `getPublicAuth` memo. Production builds it once via `getPublicAuth`.
export function createPublicAuthOptions(
  db: Awaited<ReturnType<typeof getDrizzleDb>>,
): BetterAuthOptions {
  const googleProvider = readGoogleProvider();

  return {
    // "Continue with Google" account linking. `enabled` lets an OAuth sign-in link
    // into an existing account carrying the same email; `trustedProviders` marks
    // Google a trusted source. Kept SAFE by Better Auth's default
    // `requireLocalEmailVerified` (left unset = true): a Google sign-in links into
    // an existing email/password account ONLY when that account's email is already
    // VERIFIED. A Google sign-in whose email collides with an UNVERIFIED local
    // account is REFUSED ("account not linked"), never silently merged — the
    // anti-takeover gate, since an unverified local row could have been created by
    // anyone with the victim's address. Wholly inert until the Google provider is
    // configured (env-gated `socialProviders` below).
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
    baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
    }),
    // The enlistment side effects, fired ONCE per new account (the account-redesign
    // brief). `user.create.after` runs for BOTH email/password sign-up AND social
    // (Google) sign-up — the latter lands here via the OAuth `/callback/:id` create
    // path, so both share this one seam. It (1) stamps the crew number (ruling #1) and
    // (2) auto-subscribes the email to the newsletter (ruling #5). Crew-number
    // assignment is wrapped so a race it could not win never fails the sign-up — the
    // one-time backfill recovers any unstamped row — and auto-subscribe is best-effort
    // by construction (a Resend fault is swallowed, never rethrown).
    databaseHooks: {
      user: {
        create: {
          after: async (createdUser, hookContext) => {
            try {
              await assignCrewNumber(createdUser.id);
            } catch (error) {
              console.error("crew-number assignment failed", error);
            }

            await autoSubscribeAtSignup(createdUser.email, hookContext);
          },
        },
      },
    },
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
    // Email verification on sign-up. `sendOnSignUp` mails the link the moment an
    // account is created; `autoSignInAfterVerification` signs the user in the
    // instant they click it. Delivery mirrors `sendResetPassword` exactly — a
    // Resend fault is caught and logged, never rethrown — so sign-up is
    // enumeration-safe AND never fails on an unprovisioned Resend (mobile +
    // email/password sign-up keep working unverified). `requireEmailVerification`
    // is DELIBERATELY ABSENT: sign-in never requires a verified email. Verification
    // gates future features, not the session — a Google sign-in already arrives
    // verified (Better Auth maps the provider's verified email → `emailVerified`),
    // and this rail only ever fires for the email/password path.
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
    // "Continue with Google" — spread in ONLY when both creds are present
    // (`readGoogleProvider`), so an unprovisioned Worker (or the device-auth test)
    // registers no provider and the whole leg is a no-op. A half-empty config
    // (`{ clientId: "", clientSecret: "" }`) is treated as absent, so a stray empty
    // string can never register a broken provider at auth startup.
    ...(googleProvider ? { socialProviders: { google: googleProvider } } : {}),
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

/**
 * The Google social-provider config, or `undefined` when either cred is missing.
 * Read SYNCHRONOUSLY from `process.env` (hoisted by `getPublicAuth` below, the same
 * pattern as `BETTER_AUTH_SECRET`) so `createPublicAuthOptions` stays sync and the
 * device-auth test can build the options with no Google leg. A blank value trims to
 * empty and reads as absent, so "Continue with Google" ships DARK until both the
 * `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` Worker secrets exist.
 */
function readGoogleProvider(): { clientId: string; clientSecret: string } | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();

  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/**
 * Whether "Continue with Google" is live — both creds present. Read via
 * `readOptionalEnv` (async, `.dev.vars`-aware) so the `/me` response can expose a
 * `googleEnabled` flag the account UI gates the button on, without ever rendering a
 * dead button. Independent of the `process.env` hoist so it is correct even before
 * the auth instance is first built.
 */
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

      // Hoist the Google creds onto `process.env` for the sync `readGoogleProvider`.
      // Assign only when defined — `process.env.X = undefined` would coerce to the
      // string "undefined" and falsely register a broken provider.
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
    sql: `select id, username, display_username, name, image, created_at, status, email, email_verified, crew_number from "user" where id = ? limit 1`,
  });
  const user = typedRow<PublicUserRow>(result.rows);

  if (!user || user.status !== "active") {
    return undefined;
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
