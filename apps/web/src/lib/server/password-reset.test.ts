import { type Client } from "@libsql/client";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";
import { createIntegrationDb } from "./integration-db";
import { createPublicAuthOptions } from "./public-auth";

// The password-reset rail and the Expo handshake, over the REAL production auth
// options (`createPublicAuthOptions`) on an in-memory libSQL database with the real
// migrations applied — the same harness the device-auth suite uses.
//
// Two things under test:
//   1. The config carries the mobile handshake: the `expo` plugin is registered and
//      the app scheme (`fluncle://`) is a trusted origin.
//   2. The reset request is email-enumeration-safe: `/request-password-reset`
//      returns the same 200 whether or not the address is on an account, and the
//      reset email only goes out for a real account, delivered from `sendResetPassword`.

// Capture the reset-email send without touching Resend. The mock covers EVERY
// `./resend` export the sign-up path can reach (verification email, newsletter
// segment) — a partial mock leaves those as throwing getters, which is noise here
// and a variable this suite doesn't control.
const sendPasswordResetEmail = vi.fn<(params: { to: string; url: string }) => Promise<void>>(
  async () => {},
);

vi.mock("./resend", () => ({
  addContactToSegment: async () => {},
  sendPasswordResetEmail: (params: { to: string; url: string }) => sendPasswordResetEmail(params),
  sendVerificationEmail: async () => {},
}));

let db: Client;
let auth: ReturnType<typeof betterAuth>;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const BASE_URL = "https://www.fluncle.com";

beforeEach(async () => {
  sendPasswordResetEmail.mockClear();
  db = await createIntegrationDb();
  process.env.BETTER_AUTH_SECRET = "password-reset-test-secret-not-for-production";
  process.env.BETTER_AUTH_URL = BASE_URL;
  const options = createPublicAuthOptions(drizzle(db, { schema }));

  // This suite tests the RESET rail, not sign-up verification. The verification
  // branch is what makes better-auth call `ctx.request.clone()` mid-sign-up, and on
  // Node's undici that clone intermittently throws `TypeError: unusable` (a teed
  // body-stream race — it 500'd three consecutive Cloudflare builds while passing
  // locally). Prod runs on workerd, where sign-ups verifiably work; the branch has
  // its own coverage in the device-auth and signup-hooks suites. Turning it off here
  // removes the clone from this file's path entirely.
  const testOptions: BetterAuthOptions = {
    ...options,
    emailVerification: { ...options.emailVerification, sendOnSignUp: false },
  };

  auth = betterAuth(testOptions);
});

afterEach(() => {
  db.close();
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.BETTER_AUTH_URL;
});

async function authFetch(
  path: string,
  init: { body?: unknown; headers?: Record<string, string>; method?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };

  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers.Origin ??= BASE_URL;
  }

  return auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      headers,
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    }),
  );
}

async function signUpUser(email: string): Promise<void> {
  const response = await authFetch("/sign-up/email", {
    body: { email, name: "raver", password: "a-strong-password-123", username: "raver" },
  });

  expect(response.status).toBe(200);
}

describe("mobile-accounts server config", () => {
  it("registers the Expo plugin and trusts the app scheme", () => {
    const options = createPublicAuthOptions(drizzle(db, { schema }));

    expect(options.trustedOrigins).toContain("fluncle://");
    // The web origins stay put — the scheme is additive.
    expect(options.trustedOrigins).toContain("https://www.fluncle.com");
    expect(options.plugins?.some((plugin) => plugin.id === "expo")).toBe(true);
  });

  it("enables the reset handler without requiring a schema change", () => {
    const options = createPublicAuthOptions(drizzle(db, { schema }));

    expect(options.emailAndPassword?.enabled).toBe(true);
    expect(typeof options.emailAndPassword?.sendResetPassword).toBe("function");
  });
});

describe("password-reset request (email-enumeration-safe)", () => {
  it("sends the reset email for a real account", async () => {
    await signUpUser("raver@example.com");

    const response = await authFetch("/request-password-reset", {
      body: { email: "raver@example.com", redirectTo: `${BASE_URL}/reset-password` },
    });

    expect(response.status).toBe(200);
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    const [params] = sendPasswordResetEmail.mock.calls[0] ?? [];
    expect(params?.to).toBe("raver@example.com");
    expect(typeof params?.url).toBe("string");
    expect((params?.url ?? "").length).toBeGreaterThan(0);
  });

  it("returns the same 200 and sends nothing for an unknown account", async () => {
    await signUpUser("raver@example.com");

    const response = await authFetch("/request-password-reset", {
      body: { email: "nobody@example.com", redirectTo: `${BASE_URL}/reset-password` },
    });

    // Identical response shape to the real-account case — no enumeration signal.
    expect(response.status).toBe(200);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});
