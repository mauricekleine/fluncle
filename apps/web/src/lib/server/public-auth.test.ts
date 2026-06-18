import { afterEach, describe, expect, it } from "vitest";
import {
  createCsrfToken,
  isAllowedDisplayUsername,
  isAllowedUsername,
  normalizeUsername,
  requireJsonMutation,
  resolvePublicAuthSecret,
  type PublicUser,
} from "./public-auth";

const user: PublicUser = {
  createdAt: "2026-01-01T00:00:00.000Z",
  displayUsername: "Junglist 174",
  id: "user_123",
  username: "junglist_174",
};

afterEach(() => {
  delete process.env.BETTER_AUTH_SECRET;
});

describe("public username validation", () => {
  it("normalizes the private Galaxy identity", () => {
    expect(normalizeUsername("  Junglist_174 ")).toBe("junglist_174");
  });

  it("accepts conservative usernames", () => {
    expect(isAllowedUsername("junglist_174")).toBe(true);
  });

  it("rejects reserved and noisy usernames", () => {
    expect(isAllowedUsername("admin")).toBe(false);
    expect(isAllowedUsername("fluncle")).toBe(false);
    expect(isAllowedUsername("bad-name")).toBe(false);
    expect(isAllowedUsername("__bad")).toBe(false);
  });

  it("keeps display names compact", () => {
    expect(isAllowedDisplayUsername("Junglist 174")).toBe(true);
    expect(isAllowedDisplayUsername("x")).toBe(false);
  });
});

describe("public auth hardening", () => {
  it("only uses the known fallback in local development", () => {
    expect(resolvePublicAuthSecret(undefined, true)).toBe(
      "fluncle-dev-auth-secret-change-before-production",
    );
    expect(() => resolvePublicAuthSecret(undefined, false)).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("requires same-origin metadata and a CSRF token for private mutations", () => {
    process.env.BETTER_AUTH_SECRET = "test-secret";
    const token = createCsrfToken(user);
    const valid = new Request("https://www.fluncle.com/api/me/profile", {
      body: "{}",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://www.fluncle.com",
        "x-fluncle-csrf": token,
      },
      method: "PATCH",
    });
    const missingOrigin = new Request("https://www.fluncle.com/api/me/profile", {
      body: "{}",
      headers: {
        "Content-Type": "application/json",
        "x-fluncle-csrf": token,
      },
      method: "PATCH",
    });
    const missingToken = new Request("https://www.fluncle.com/api/me/profile", {
      body: "{}",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://www.fluncle.com",
      },
      method: "PATCH",
    });

    expect(requireJsonMutation(valid, user)).toBeUndefined();
    expect(requireJsonMutation(missingOrigin, user)?.status).toBe(403);
    expect(requireJsonMutation(missingToken, user)?.status).toBe(403);
  });
});
