import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_COOKIE_NAME, ADMIN_GRANT_EPOCH_KEY, requireAdminMutationOrigin } from "./env";
import {
  AGENT_TOKEN,
  apiUrl,
  OPERATOR_TOKEN,
  readJson,
  setAdminTokenEnv,
  warmOrpcRouter,
} from "./orpc-test-kit";

const SESSION_SECRET = "test-session-secret-admin-origin";

let epochValue: string | undefined;

vi.mock("./settings", () => ({
  deleteSetting: async () => {
    epochValue = undefined;
  },
  getSetting: async (key: string) => (key === ADMIN_GRANT_EPOCH_KEY ? epochValue : undefined),
  setSetting: async (key: string, value: string) => {
    if (key === ADMIN_GRANT_EPOCH_KEY) {
      epochValue = value;
    }
  },
}));

const lastfmGetToken = vi.fn();

vi.mock("./lastfm", () => ({
  lastfmGetSession: vi.fn(),
  lastfmGetToken: (...args: unknown[]) => lastfmGetToken(...args),
}));

beforeAll(() => {
  setAdminTokenEnv();
  process.env.ADMIN_SESSION_SECRET = SESSION_SECRET;
});

warmOrpcRouter();

beforeEach(() => {
  epochValue = undefined;
  lastfmGetToken.mockReset();
});

async function grantCookieHeader(): Promise<string> {
  const { signGrant } = await import("./admin-auth");

  return `${ADMIN_COOKIE_NAME}=${await signGrant()}`;
}

const REVOKE_PATH = "/admin/auth/revoke-grants";

function request(path: string, method: string, headers: Record<string, string>): Request {
  return new Request(apiUrl(path), { headers, method });
}

describe("requireAdminMutationOrigin (the helper)", () => {
  const url = "https://www.fluncle.com/api/v1/admin/labels/x";

  it("ignores safe methods (a read is never origin-checked)", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(requireAdminMutationOrigin(new Request(url, { method }))).toBeUndefined();
    }
  });

  it("exempts a Bearer caller even with no Origin AND with a foreign one", () => {
    expect(
      requireAdminMutationOrigin(
        new Request(url, { headers: { Authorization: "Bearer whatever" }, method: "PATCH" }),
      ),
    ).toBeUndefined();
    expect(
      requireAdminMutationOrigin(
        new Request(url, {
          headers: { Authorization: "Bearer whatever", origin: "https://evil.example" },
          method: "PATCH",
        }),
      ),
    ).toBeUndefined();
  });

  it("allows a matching Origin", () => {
    expect(
      requireAdminMutationOrigin(
        new Request(url, { headers: { origin: "https://www.fluncle.com" }, method: "POST" }),
      ),
    ).toBeUndefined();
  });

  it("refuses a foreign Origin — including a sibling subdomain SameSite=Lax would allow", async () => {
    for (const origin of [
      "https://evil.example",
      "https://evil.fluncle.com",
      "http://www.fluncle.com",
      "https://www.fluncle.com.evil.example",
    ]) {
      const response = requireAdminMutationOrigin(
        new Request(url, { headers: { origin }, method: "POST" }),
      );

      expect(response?.status, origin).toBe(403);

      if (!response) {
        throw new Error(`expected a refusal for ${origin}`);
      }

      expect(((await response.json()) as { code: string }).code).toBe("invalid_origin");
    }
  });

  it("falls back to the Referer when Origin is absent", () => {
    expect(
      requireAdminMutationOrigin(
        new Request(url, {
          headers: { referer: "https://www.fluncle.com/admin/labels" },
          method: "DELETE",
        }),
      ),
    ).toBeUndefined();
    expect(
      requireAdminMutationOrigin(
        new Request(url, { headers: { referer: "https://evil.example/x" }, method: "DELETE" }),
      )?.status,
    ).toBe(403);
    expect(
      requireAdminMutationOrigin(
        new Request(url, { headers: { referer: "not-a-url" }, method: "DELETE" }),
      )?.status,
    ).toBe(403);
  });

  it("refuses a cookie-carried mutation with NEITHER header", () => {
    expect(requireAdminMutationOrigin(new Request(url, { method: "POST" }))?.status).toBe(403);
  });

  it("prefers Origin over Referer (a matching Referer cannot rescue a foreign Origin)", () => {
    expect(
      requireAdminMutationOrigin(
        new Request(url, {
          headers: {
            origin: "https://evil.fluncle.com",
            referer: "https://www.fluncle.com/admin",
          },
          method: "POST",
        }),
      )?.status,
    ).toBe(403);
  });
});

describe("the guard on the live oRPC admin tier (POST /admin/auth/revoke-grants)", () => {
  it("ALLOWS the CLI: Bearer, no Origin, no cookie", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      request(REVOKE_PATH, "POST", { Authorization: `Bearer ${OPERATOR_TOKEN}` }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ epoch: 1, ok: true });
  });

  it("ALLOWS the browser: grant cookie with a matching Origin", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      request(REVOKE_PATH, "POST", {
        cookie: await grantCookieHeader(),
        origin: "https://www.fluncle.com",
      }),
    );

    expect(response?.status).toBe(200);
  });

  it("BLOCKS a cookie-carried mutation from a foreign origin (403 invalid_origin)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      request(REVOKE_PATH, "POST", {
        cookie: await grantCookieHeader(),
        origin: "https://evil.fluncle.com",
      }),
    );

    expect(response?.status).toBe(403);
    expect(((await readJson(response)) as { code: string }).code).toBe("invalid_origin");

    expect(epochValue).toBeUndefined();
  });

  it("BLOCKS a cookie-carried mutation with no Origin and no Referer", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      request(REVOKE_PATH, "POST", { cookie: await grantCookieHeader() }),
    );

    expect(response?.status).toBe(403);
    expect(epochValue).toBeUndefined();
  });

  it("still 401s an unauthenticated caller (auth wins over the origin guard)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      request(REVOKE_PATH, "POST", { origin: "https://evil.fluncle.com" }),
    );

    expect(response?.status).toBe(401);
  });

  it("still 403s the AGENT role (the guard does not swallow the role check)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      request(REVOKE_PATH, "POST", { Authorization: `Bearer ${AGENT_TOKEN}` }),
    );

    expect(response?.status).toBe(403);
    expect(((await readJson(response)) as { code: string }).code).toBe("forbidden");
    expect(epochValue).toBeUndefined();
  });

  it("leaves an admin GET alone: a cookie-carried READ with no Origin still passes", async () => {
    lastfmGetToken.mockResolvedValueOnce({ authUrl: "https://last.fm/auth", token: "rt-1" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      request("/admin/lastfm/auth/start", "GET", { cookie: await grantCookieHeader() }),
    );

    expect(response?.status).toBe(200);
    expect(lastfmGetToken).toHaveBeenCalled();
  });
});
