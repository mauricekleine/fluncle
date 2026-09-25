import { type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";
import { betterAuth } from "better-auth";
import { createIntegrationAuth } from "./integration-auth";
import { createIntegrationDb } from "./integration-db";
import { createPublicAuthOptions } from "./public-auth";

let db: Client;

const BASE_URL = "https://www.fluncle.com";

const sendMagicLinkEmail = vi.fn<(params: { to: string; url: string }) => Promise<void>>();
const addContactToSegment = vi.fn<(email: string) => Promise<void>>();

vi.mock("./discord-alert", () => ({ notifyDiscordSignup: async () => {} }));

vi.mock("./resend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./resend")>();

  return {
    ...actual,
    addContactToSegment: (email: string) => addContactToSegment(email),
    sendMagicLinkEmail: (params: { to: string; url: string }) => sendMagicLinkEmail(params),
    sendPasswordResetEmail: vi.fn(async () => {}),
    sendVerificationEmail: vi.fn(async () => {}),
  };
});

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return {
    ...actual,
    getDb: () => Promise.resolve(db),
    getDrizzleDb: () => Promise.resolve(drizzle(db, { schema })),
  };
});

beforeEach(async () => {
  sendMagicLinkEmail.mockReset();
  sendMagicLinkEmail.mockResolvedValue(undefined);
  addContactToSegment.mockReset();
  addContactToSegment.mockResolvedValue(undefined);
  db = await createIntegrationDb();
  process.env.BETTER_AUTH_SECRET = "magic-link-test-secret-not-for-production";
  process.env.BETTER_AUTH_URL = BASE_URL;
});

afterEach(() => {
  db.close();
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.BETTER_AUTH_URL;
});

function buildAuth() {
  return createIntegrationAuth(drizzle(db, { schema }));
}

async function requestLink(
  auth: ReturnType<typeof buildAuth>,
  body: Record<string, unknown>,
): Promise<Response> {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/magic-link`, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", Origin: BASE_URL },
      method: "POST",
    }),
  );
}

function sentUrl(): URL {
  const [params] = sendMagicLinkEmail.mock.calls.at(-1) ?? [];

  if (!params) {
    throw new Error("no magic link was sent");
  }

  return new URL(params.url);
}

async function openLink(auth: ReturnType<typeof buildAuth>, url: URL): Promise<Response> {
  return auth.handler(new Request(url.toString(), { method: "GET", redirect: "manual" }));
}

async function userRow(email: string) {
  const result = await db.execute({
    args: [email],
    sql: `select id, email_verified, crew_number from "user" where email = ?`,
  });

  return result.rows[0];
}

describe("magic-link sign-in", () => {
  it("emails a single-use link that creates a verified account and signs it in", async () => {
    const auth = buildAuth();
    const response = await requestLink(auth, {
      callbackURL: "/account",
      email: "jade@example.com",
    });

    expect(response.status).toBe(200);
    expect(sendMagicLinkEmail).toHaveBeenCalledTimes(1);
    expect(sendMagicLinkEmail.mock.calls[0]?.[0]?.to).toBe("jade@example.com");

    const link = sentUrl();

    expect(link.origin).toBe(BASE_URL);
    expect(link.pathname).toBe("/api/auth/magic-link/verify");
    expect(link.searchParams.get("callbackURL")).toBe("/account");

    const verified = await openLink(auth, link);

    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe(`${BASE_URL}/account`);
    expect(verified.headers.get("set-cookie") ?? "").toContain("fluncle_user.session_token");

    const row = await userRow("jade@example.com");

    expect(Number(row?.email_verified)).toBe(1);
    expect(Number(row?.crew_number)).toBeGreaterThan(0);
    expect(addContactToSegment).toHaveBeenCalledWith("jade@example.com");

    const replay = await openLink(auth, link);

    expect(replay.headers.get("location")).toContain("error=INVALID_TOKEN");
  });

  it("signs an existing account in without creating a second user", async () => {
    const auth = buildAuth();

    await auth.api.signUpEmail({
      body: { email: "dave@example.com", name: "Dave", password: "amenbreak-1994" },
    });

    await requestLink(auth, { callbackURL: "/account", email: "dave@example.com" });
    const verified = await openLink(auth, sentUrl());

    expect(verified.status).toBe(302);

    const count = await db.execute({
      args: ["dave@example.com"],
      sql: `select count(*) as n from "user" where email = ?`,
    });

    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it("stores only a hash of the token", async () => {
    const auth = buildAuth();

    await requestLink(auth, { callbackURL: "/account", email: "priya@example.com" });
    const token = sentUrl().searchParams.get("token") ?? "";
    const stored = await db.execute({
      args: [token],
      sql: `select count(*) as n from verification where identifier = ?`,
    });

    expect(token.length).toBeGreaterThan(20);
    expect(Number(stored.rows[0]?.n)).toBe(0);
  });

  it("refuses an off-site callback before any email is sent", async () => {
    const options = createPublicAuthOptions(drizzle(db, { schema }));
    const strictAuth = betterAuth({
      ...options,
      advanced: { ...options.advanced, disableOriginCheck: false },
    });

    const response = await strictAuth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/magic-link`, {
        body: JSON.stringify({ callbackURL: "https://evil.example/steal", email: "m@example.com" }),
        headers: { "Content-Type": "application/json", Origin: BASE_URL },
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
    expect(sendMagicLinkEmail).not.toHaveBeenCalled();
  });
});
