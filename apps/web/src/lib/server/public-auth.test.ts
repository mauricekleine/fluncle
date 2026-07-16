import { afterEach, describe, expect, it } from "vitest";
import {
  createPublicAuthOptions,
  createCsrfToken,
  isAllowedDisplayUsername,
  isAllowedUsername,
  normalizeUsername,
  requireJsonMutation,
  resolvePublicAuthSecret,
  type PublicUser,
} from "./public-auth";

// The config builder only stores the db lazily (drizzleAdapter), so a stub is enough
// to assert the shape of the options object it returns.
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

    // Sends on sign-up, auto-signs-in after verifying, and delivers via a hook.
    expect(options.emailVerification?.sendOnSignUp).toBe(true);
    expect(options.emailVerification?.autoSignInAfterVerification).toBe(true);
    expect(typeof options.emailVerification?.sendVerificationEmail).toBe("function");
    // The load-bearing negative: verification NEVER gates the session. If this ever
    // becomes truthy, an unverified user (incl. every mobile sign-up) is locked out.
    expect(options.emailAndPassword?.requireEmailVerification).toBeUndefined();
  });

  it("trusts Google for account linking (the anti-takeover default stays on)", () => {
    const options = createPublicAuthOptions(stubDb);

    expect(options.account?.accountLinking?.enabled).toBe(true);
    expect(options.account?.accountLinking?.trustedProviders).toContain("google");
    // We rely on Better Auth's default requireLocalEmailVerified (true): a Google
    // sign-in links into an existing account only when it is already verified. If we
    // ever set this false, an unverified local row becomes linkable — account takeover.
    expect(options.account?.accountLinking?.requireLocalEmailVerified).toBeUndefined();
  });

  it("ships Google DARK until both creds exist (conditional spread)", () => {
    expect(createPublicAuthOptions(stubDb).socialProviders).toBeUndefined();

    // Only one cred present is still dark — a half-empty config must never register.
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
