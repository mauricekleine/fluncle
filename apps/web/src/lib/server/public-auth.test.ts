import { afterEach, describe, expect, it } from "vitest";
import {
  createPublicAuthOptions,
  createCsrfToken,
  isAllowedDisplayUsername,
  isAllowedUsername,
  normalizeUsername,
  requireJsonMutation,
  resolvePublicAuthBaseUrl,
  resolvePublicAuthSecret,
  type PublicUser,
  LAST_SEEN_BUMP_MS,
  shouldBumpLastSeen,
} from "./public-auth";

const stubDb = {} as Parameters<typeof createPublicAuthOptions>[0];

const user: PublicUser = {
  createdAt: "2026-01-01T00:00:00.000Z",
  displayUsername: "Junglist 174",
  email: "junglist@example.com",
  emailVerified: false,
  id: "user_123",
  name: "Junglist 174",
  username: "junglist_174",
};

afterEach(() => {
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

describe("createPublicAuthOptions", () => {
  it("wires email verification without gating sign-in", () => {
    const options = createPublicAuthOptions(stubDb);

    expect(options.emailVerification?.sendOnSignUp).toBe(true);
    expect(options.emailVerification?.autoSignInAfterVerification).toBe(true);
    expect(typeof options.emailVerification?.sendVerificationEmail).toBe("function");

    expect(options.emailAndPassword?.requireEmailVerification).toBeUndefined();
  });

  it("trusts Google for account linking (the anti-takeover default stays on)", () => {
    const options = createPublicAuthOptions(stubDb);

    expect(options.account?.accountLinking?.enabled).toBe(true);
    expect(options.account?.accountLinking?.trustedProviders).toContain("google");

    expect(options.account?.accountLinking?.requireLocalEmailVerified).toBeUndefined();
  });

  it("ships Google DARK until both creds exist (conditional spread)", () => {
    expect(createPublicAuthOptions(stubDb).socialProviders).toBeUndefined();

    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    expect(createPublicAuthOptions(stubDb).socialProviders).toBeUndefined();

    process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
    const withBoth = createPublicAuthOptions(stubDb).socialProviders as
      | { google?: { clientId: string; clientSecret: string } }
      | undefined;
    expect(withBoth?.google?.clientId).toBe("google-client-id");
    expect(withBoth?.google?.clientSecret).toBe("google-client-secret");
  });

  it("treats a blank cred as absent (no broken provider at startup)", () => {
    process.env.GOOGLE_CLIENT_ID = "   ";
    process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";

    expect(createPublicAuthOptions(stubDb).socialProviders).toBeUndefined();
  });
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

  it("requires BETTER_AUTH_URL outside local development, and never falls back silently", () => {
    expect(resolvePublicAuthBaseUrl(undefined, true)).toBe("http://localhost:3000");
    expect(resolvePublicAuthBaseUrl("https://www.fluncle.com", false)).toBe(
      "https://www.fluncle.com",
    );

    expect(resolvePublicAuthBaseUrl("  https://www.fluncle.com\n", false)).toBe(
      "https://www.fluncle.com",
    );
    expect(() => resolvePublicAuthBaseUrl(undefined, false)).toThrow(/BETTER_AUTH_URL/);

    expect(() => resolvePublicAuthBaseUrl("", false)).toThrow(/BETTER_AUTH_URL/);
    expect(() => resolvePublicAuthBaseUrl("   ", false)).toThrow(/BETTER_AUTH_URL/);
  });

  it("trusts the apex alongside www so an apex-served auth call is not an auth error", () => {
    process.env.BETTER_AUTH_SECRET = "test-secret";
    const options = createPublicAuthOptions(stubDb);

    expect(options.trustedOrigins).toContain("https://fluncle.com");
    expect(options.trustedOrigins).toContain("https://www.fluncle.com");
    expect(options.trustedOrigins).toContain("fluncle://");

    expect(options.trustedOrigins).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://fluncle.com",
      "https://www.fluncle.com",
      "fluncle://",
    ]);
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

describe("shouldBumpLastSeen (the presence-stamp throttle)", () => {
  it("always bumps a never-seen user (NULL stamp)", () => {
    expect(shouldBumpLastSeen(null, 1_000)).toBe(true);
  });

  it("holds inside the window and bumps once it has fully passed", () => {
    const seen = 1_000_000;

    expect(shouldBumpLastSeen(seen, seen + LAST_SEEN_BUMP_MS)).toBe(false);
    expect(shouldBumpLastSeen(seen, seen + LAST_SEEN_BUMP_MS + 1)).toBe(true);
  });
});
