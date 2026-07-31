import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl, get, readJson } from "./orpc-test-kit";

const assertRateLimit = vi.fn<(options: unknown) => Promise<void>>();

// The shared limiter's atomic DB behavior has focused coverage in
// rate-limit.test.ts. This suite exercises the contract-bound handler and its
// Platform API boundary, so the app database is honestly absent.
vi.mock("./rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rate-limit")>();

  return {
    ...actual,
    assertRateLimit: (options: unknown) => assertRateLimit(options),
  };
});

const ENV_KEYS = [
  "DEVICE_REPLICA_DB_NAME",
  "DEVICE_REPLICA_DB_URL",
  "TURSO_PLATFORM_ORG",
  "TURSO_PLATFORM_TOKEN",
] as const;
const savedEnv = new Map<string, string | undefined>();

function configureReplica(): void {
  process.env.DEVICE_REPLICA_DB_NAME = "device-catalogue";
  process.env.DEVICE_REPLICA_DB_URL = "libsql://device-catalogue.example.turso.io";
  process.env.TURSO_PLATFORM_ORG = "test-organization";
  process.env.TURSO_PLATFORM_TOKEN = "test-platform-token";
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }

  assertRateLimit.mockReset();
  assertRateLimit.mockResolvedValue(undefined);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-31T10:00:00.000Z"));
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  savedEnv.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("oRPC public read — GET /replica/token (get_replica_token)", () => {
  it("mints a 24-hour read-only token through the Turso Platform API", async () => {
    configureReplica();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ jwt: "test-device-jwt" }));
    vi.stubGlobal("fetch", fetchMock);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(apiUrl("/replica/token")));

    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await readJson(response)).toEqual({
      expiresAt: "2026-08-01T10:00:00.000Z",
      token: "test-device-jwt",
      url: "libsql://device-catalogue.example.turso.io",
    });
    expect(assertRateLimit).toHaveBeenCalledWith({
      action: "get_replica_token",
      limit: 2,
      request: expect.any(Request),
      windowMs: 60 * 60 * 1000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [requestUrl, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl).toBeInstanceOf(URL);
    expect(requestUrl instanceof URL ? requestUrl.href : "").toBe(
      "https://api.turso.tech/v1/organizations/test-organization/databases/device-catalogue/auth/tokens?authorization=read-only&expiration=1d",
    );
    expect(init).toEqual({
      headers: { Authorization: "Bearer test-platform-token" },
      method: "POST",
    });
  });

  it("503s with replica_unavailable when configuration is absent, without touching DB or network", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(apiUrl("/replica/token")));

    expect(response?.status).toBe(503);
    expect(await readJson(response)).toEqual({
      code: "replica_unavailable",
      message: "The device replica is unavailable.",
      ok: false,
    });
    expect(assertRateLimit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a Platform API failure to replica_unavailable without logging token material", async () => {
    configureReplica();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ detail: "upstream rejected test-device-jwt" }, { status: 503 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(get(apiUrl("/replica/token")));

    expect(response?.status).toBe(503);
    const body = await readJson(response);
    expect(body).toEqual({
      code: "replica_unavailable",
      message: "The device replica is unavailable.",
      ok: false,
    });
    expect(JSON.stringify(body)).not.toContain("test-device-jwt");
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
