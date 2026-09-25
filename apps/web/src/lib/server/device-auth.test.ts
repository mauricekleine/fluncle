import { type Client } from "@libsql/client";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";
import { createIntegrationDb } from "./integration-db";
import { createIntegrationAuth } from "./integration-auth";

let db: Client;
let auth: ReturnType<typeof betterAuth>;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const ADMIN_TOKEN = "admin-operator-token-device-test";
const BASE_URL = "https://www.fluncle.com";

beforeEach(async () => {
  db = await createIntegrationDb();
  process.env.BETTER_AUTH_SECRET = "device-auth-test-secret-not-for-production-use";
  process.env.BETTER_AUTH_URL = BASE_URL;
  process.env.FLUNCLE_API_TOKEN = ADMIN_TOKEN;
  delete process.env.FLUNCLE_AGENT_TOKEN;

  auth = createIntegrationAuth(drizzle(db, { schema }));
});

afterEach(() => {
  db.close();
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.BETTER_AUTH_URL;
  delete process.env.FLUNCLE_API_TOKEN;
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

async function signUpUser(): Promise<{ bearerToken: string; cookie: string }> {
  const response = await authFetch("/sign-up/email", {
    body: {
      email: "raver@example.com",
      name: "raver",
      password: "a-strong-password-123",
      username: "raver",
    },
  });

  expect(response.status).toBe(200);

  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  const bearerToken = response.headers.get("set-auth-token") ?? "";

  expect(cookie).toContain("fluncle_user");
  expect(bearerToken).not.toBe("");

  return { bearerToken, cookie };
}

async function claimUserCode(userCode: string, cookie: string): Promise<void> {
  const claim = await authFetch(`/device?user_code=${encodeURIComponent(userCode)}`, {
    headers: { cookie },
  });
  expect(claim.status).toBe(200);
}

async function approveDeviceCode(): Promise<{ deviceCode: string; userCode: string }> {
  const { cookie } = await signUpUser();
  const code = (await (
    await authFetch("/device/code", { body: { client_id: "fluncle-cli", scope: "galaxy-sync" } })
  ).json()) as { device_code: string; user_code: string };

  await claimUserCode(code.user_code, cookie);

  const approve = await authFetch("/device/approve", {
    body: { userCode: code.user_code },
    headers: { cookie },
  });
  expect(approve.status).toBe(200);

  return { deviceCode: code.device_code, userCode: code.user_code };
}

async function pollToken(deviceCode: string): Promise<Response> {
  return authFetch("/device/token", {
    body: {
      client_id: "fluncle-cli",
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
  });
}

describe("device-authorization login flow", () => {
  it("issues a device code, approves it, and exchanges it for a working session token", async () => {
    const { cookie } = await signUpUser();

    const codeResponse = await authFetch("/device/code", {
      body: { client_id: "fluncle-cli", scope: "galaxy-sync" },
    });
    expect(codeResponse.status).toBe(200);
    const code = (await codeResponse.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
    };
    expect(code.device_code).toBeTruthy();
    expect(code.user_code).toBeTruthy();
    expect(code.verification_uri).toContain("/device");

    await claimUserCode(code.user_code, cookie);
    const approve = await authFetch("/device/approve", {
      body: { userCode: code.user_code },
      headers: { cookie },
    });
    expect(approve.status).toBe(200);

    const tokenResponse = await pollToken(code.device_code);
    expect(tokenResponse.status).toBe(200);
    const token = (await tokenResponse.json()) as { access_token: string };
    expect(token.access_token).toBeTruthy();

    const session = await auth.api.getSession({
      headers: new Headers({ Authorization: `Bearer ${token.access_token}` }),
    });
    expect(session?.user.id).toBeTruthy();
    expect(session?.user.email).toBe("raver@example.com");
  });

  it("a poll before approval is pending, not minted", async () => {
    await signUpUser();
    const code = (await (
      await authFetch("/device/code", { body: { client_id: "fluncle-cli" } })
    ).json()) as { device_code: string };

    const pending = await pollToken(code.device_code);
    expect(pending.status).toBe(400);
    expect((await pending.json()) as { error: string }).toMatchObject({
      error: "authorization_pending",
    });
  });

  it("rejects an unknown OAuth client id (only the first-party CLI is trusted)", async () => {
    const response = await authFetch("/device/code", {
      body: { client_id: "some-other-app", scope: "galaxy-sync" },
    });

    expect(response.status).toBe(400);
  });

  it("a denied code never mints a token", async () => {
    const { cookie } = await signUpUser();
    const code = (await (
      await authFetch("/device/code", { body: { client_id: "fluncle-cli" } })
    ).json()) as { device_code: string; user_code: string };

    await claimUserCode(code.user_code, cookie);
    const deny = await authFetch("/device/deny", {
      body: { userCode: code.user_code },
      headers: { cookie },
    });
    expect(deny.status).toBe(200);

    const tokenResponse = await pollToken(code.device_code);
    expect(tokenResponse.status).toBe(400);
    expect((await tokenResponse.json()) as { error: string }).toMatchObject({
      error: "access_denied",
    });
  });
});

describe("user/admin token boundary", () => {
  async function mintUserToken(): Promise<string> {
    const { deviceCode } = await approveDeviceCode();
    const token = (await (await pollToken(deviceCode)).json()) as { access_token: string };

    return token.access_token;
  }

  it("a USER session token is NOT an admin credential", async () => {
    const userToken = await mintUserToken();
    const { adminRole } = await import("./env");

    const role = await adminRole(
      new Request(`${BASE_URL}/api/admin/tracks/x`, {
        headers: { Authorization: `Bearer ${userToken}` },
        method: "PATCH",
      }),
    );

    expect(role).toBeNull();
  });

  it("the ADMIN token is NOT a user session", async () => {
    await mintUserToken();

    const session = await auth.api.getSession({
      headers: new Headers({ Authorization: `Bearer ${ADMIN_TOKEN}` }),
    });

    expect(session).toBeNull();
  });

  it("an admin Bearer that isn't the configured token resolves no role", async () => {
    const { adminRole } = await import("./env");

    const role = await adminRole(
      new Request(`${BASE_URL}/api/admin/tracks/x`, {
        headers: { Authorization: "Bearer not-a-real-token" },
        method: "PATCH",
      }),
    );

    expect(role).toBeNull();
  });
});
