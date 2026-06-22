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

  // The CSRF signature check ends in timingSafeEqual, which THROWS when the two
  // buffers differ in length. verifyCsrfToken wraps it in try/catch so a malformed
  // (wrong-length) signature is a clean 403, never an unhandled 500 and never a
  // bypass. These drive that path through the public requireJsonMutation surface;
  // origin/bucket are kept valid so the request reaches the signature comparison.
  describe("the CSRF signature comparison (timingSafeEqual length-mismatch)", () => {
    const mutationRequest = (csrfToken: string): Request =>
      new Request("https://www.fluncle.com/api/me/profile", {
        body: "{}",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.fluncle.com",
          "x-fluncle-csrf": csrfToken,
        },
        method: "PATCH",
      });

    // The body+bucket prefix of a freshly-minted token, with a swappable signature.
    const tokenWith = (signature: string): string => {
      process.env.BETTER_AUTH_SECRET = "test-secret";
      const validParts = createCsrfToken(user).split(".");

      return `${validParts[0]}.${validParts[1]}.${signature}`;
    };

    it("rejects an empty signature with a 403 (length mismatch, no throw)", () => {
      const request = mutationRequest(tokenWith(""));

      expect(() => requireJsonMutation(request, user)).not.toThrow();
      expect(requireJsonMutation(request, user)?.status).toBe(403);
    });

    it("rejects a shorter-than-expected signature with a 403", () => {
      const request = mutationRequest(tokenWith("deadbeef"));

      expect(() => requireJsonMutation(request, user)).not.toThrow();
      expect(requireJsonMutation(request, user)?.status).toBe(403);
    });

    it("rejects a longer-than-expected signature with a 403", () => {
      const request = mutationRequest(tokenWith("z".repeat(256)));

      expect(() => requireJsonMutation(request, user)).not.toThrow();
      expect(requireJsonMutation(request, user)?.status).toBe(403);
    });

    it("rejects an exact-length-but-wrong signature with a 403 (no bypass)", () => {
      process.env.BETTER_AUTH_SECRET = "test-secret";
      const validParts = createCsrfToken(user).split(".");
      const realSignature = validParts[2] ?? "";
      // Flip the final character to keep the byte-length identical but the value wrong.
      const flipped = realSignature.slice(0, -1) + (realSignature.endsWith("A") ? "B" : "A");
      const request = mutationRequest(`${validParts[0]}.${validParts[1]}.${flipped}`);

      expect(flipped.length).toBe(realSignature.length);
      expect(requireJsonMutation(request, user)?.status).toBe(403);
    });

    it("accepts the genuine signature (the comparison still passes a real token)", () => {
      process.env.BETTER_AUTH_SECRET = "test-secret";
      const request = mutationRequest(createCsrfToken(user));

      expect(requireJsonMutation(request, user)).toBeUndefined();
    });
  });
});
