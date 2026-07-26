import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { adminRole, constantTimeEqual } from "./env";

// constantTimeEqual guards the admin Bearer comparison (adminRole, line ~190/196)
// and the OAuth-state signature check (verifySignedState, line ~299). Node's
// crypto.timingSafeEqual THROWS when the two buffers differ in length — a classic
// footgun that would turn an intended 401 into an unhandled 500. The wrapper's
// length guard must make every length-mismatch a clean `false`, never a throw and
// never a bypass.
describe("constantTimeEqual — length-mismatch safety", () => {
  const expected = "the-real-operator-token";

  it("returns false for an empty token (length mismatch, must not throw)", () => {
    expect(() => constantTimeEqual("", expected)).not.toThrow();
    expect(constantTimeEqual("", expected)).toBe(false);
  });

  it("returns false for a shorter-than-expected token (must not throw)", () => {
    const shorter = expected.slice(0, expected.length - 5);

    expect(() => constantTimeEqual(shorter, expected)).not.toThrow();
    expect(constantTimeEqual(shorter, expected)).toBe(false);
  });

  it("returns false for a longer-than-expected token (must not throw)", () => {
    const longer = `${expected}-with-extra-suffix`;

    expect(() => constantTimeEqual(longer, expected)).not.toThrow();
    expect(constantTimeEqual(longer, expected)).toBe(false);
  });

  it("returns false for an exact-length-but-wrong token (no bypass)", () => {
    const wrong = `${"x".repeat(expected.length - 1)}y`;

    expect(wrong.length).toBe(expected.length);
    expect(constantTimeEqual(wrong, expected)).toBe(false);
  });

  it("returns true only for an exact match", () => {
    expect(constantTimeEqual(expected, expected)).toBe(true);
  });

  it("treats two empty strings as equal (zero-length pair is not a mismatch)", () => {
    expect(() => constantTimeEqual("", "")).not.toThrow();
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("handles multibyte tokens whose char-length matches but byte-length differs", () => {
    // "é" is 2 bytes in UTF-8; "ee" is 2 bytes. A naive String.length guard would
    // see equal lengths and hand mismatched-byte-length buffers to timingSafeEqual
    // (a throw). The byte-buffer guard keeps it a clean false.
    expect(() => constantTimeEqual("é", "ee")).not.toThrow();
    expect(constantTimeEqual("é", "ee")).toBe(false);
  });
});

// adminRole is the ONE gate every /api/admin/* route reads (requireAdmin and
// requireOperator both call it). It reads the two Bearer carriers out of the env, and an
// UNPROVISIONED deployment must still answer unauthorized — not throw. The operator read
// used to be the THROWING `readEnv`, so a Bearer request against a Worker with no
// FLUNCLE_API_TOKEN (a preview branch, a half-configured deploy) raised
// `Missing FLUNCLE_API_TOKEN` out of the auth check and surfaced as an unhandled 500: an
// availability bug that also named the missing secret. Pin the graceful shape: an absent
// secret means that carrier simply cannot authenticate, and the request falls through.
describe("adminRole — an unprovisioned deployment answers unauthorized, never throws", () => {
  const guarded = ["ADMIN_SESSION_SECRET", "FLUNCLE_AGENT_TOKEN", "FLUNCLE_API_TOKEN"] as const;
  const saved = new Map<string, string | undefined>();

  function bearer(token: string): Request {
    return new Request("https://www.fluncle.com/api/v1/admin/tracks", {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  beforeEach(() => {
    for (const key of guarded) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    saved.clear();
  });

  it("returns null (never throws) when FLUNCLE_API_TOKEN is not provisioned", async () => {
    await expect(adminRole(bearer("some-presented-token"))).resolves.toBeNull();
  });

  it("still admits the AGENT when only FLUNCLE_AGENT_TOKEN is provisioned", async () => {
    process.env["FLUNCLE_AGENT_TOKEN"] = "the-agent-token";

    expect(await adminRole(bearer("the-agent-token"))).toBe("agent");
    expect(await adminRole(bearer("not-the-agent-token"))).toBeNull();
  });

  it("admits the OPERATOR on an exact FLUNCLE_API_TOKEN match", async () => {
    process.env["FLUNCLE_API_TOKEN"] = "the-operator-token";

    expect(await adminRole(bearer("the-operator-token"))).toBe("operator");
    expect(await adminRole(bearer("the-operator-tokeX"))).toBeNull();
  });

  it("returns null for a request carrying no Authorization header at all", async () => {
    process.env["FLUNCLE_API_TOKEN"] = "the-operator-token";

    const bare = new Request("https://www.fluncle.com/api/v1/admin/tracks");

    await expect(adminRole(bare)).resolves.toBeNull();
  });
});
