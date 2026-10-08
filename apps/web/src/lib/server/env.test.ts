import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { adminRole, constantTimeEqual, readEnv, readEnvs, readOptionalEnv } from "./env";

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
    expect(() => constantTimeEqual("é", "ee")).not.toThrow();
    expect(constantTimeEqual("é", "ee")).toBe(false);
  });
});

describe("adminRole — an unprovisioned deployment answers unauthorized, never throws", () => {
  const guarded = [
    "ADMIN_SESSION_SECRET",
    "DISCORD_WEBHOOK_URL",
    "DISCORD_ALERT_WEBHOOK",
    "FLUNCLE_AGENT_TOKEN",
    "FLUNCLE_SOLITON_AGENT_TOKEN",
    "FLUNCLE_API_TOKEN",
  ] as const;
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

  it("admits the AGENT on either agent token, each on its own", async () => {
    process.env["FLUNCLE_AGENT_TOKEN"] = "the-box-agent-token";
    process.env["FLUNCLE_SOLITON_AGENT_TOKEN"] = "the-soliton-agent-token";

    expect(await adminRole(bearer("the-box-agent-token"))).toBe("agent");
    expect(await adminRole(bearer("the-soliton-agent-token"))).toBe("agent");

    delete process.env["FLUNCLE_AGENT_TOKEN"];

    expect(await adminRole(bearer("the-box-agent-token"))).toBeNull();
    expect(await adminRole(bearer("the-soliton-agent-token"))).toBe("agent");
  });

  it("never admits the OPERATOR on the Soliton agent token", async () => {
    process.env["FLUNCLE_API_TOKEN"] = "the-operator-token";
    process.env["FLUNCLE_SOLITON_AGENT_TOKEN"] = "the-soliton-agent-token";

    expect(await adminRole(bearer("the-soliton-agent-token"))).toBe("agent");
  });

  it("admits the OPERATOR on an exact FLUNCLE_API_TOKEN match", async () => {
    process.env["FLUNCLE_API_TOKEN"] = "the-operator-token";

    expect(await adminRole(bearer("the-operator-token"))).toBe("operator");
    expect(await adminRole(bearer("the-operator-tokeX"))).toBeNull();
  });

  it("rejects a disabled credential even when the bearer matches it", async () => {
    process.env["FLUNCLE_API_TOKEN"] = "disabled-for-agents";

    await expect(adminRole(bearer("disabled-for-agents"))).resolves.toBeNull();
  });

  it.each([
    ["FLUNCLE_API_TOKEN", "disabled-for-agents"],
    ["DISCORD_WEBHOOK_URL", "https://discord.invalid/webhook"],
    ["DISCORD_ALERT_WEBHOOK", "https://discord.invalid/alert"],
  ] as const)("treats a disabled %s as unprovisioned", async (key, value) => {
    process.env[key] = value;

    await expect(readOptionalEnv(key)).resolves.toBeUndefined();
    await expect(readEnv(key)).rejects.toThrow(`Disabled ${key}`);
    await expect(readEnvs([key])).rejects.toThrow(`Disabled ${key}`);
  });

  it("returns null for a request carrying no Authorization header at all", async () => {
    process.env["FLUNCLE_API_TOKEN"] = "the-operator-token";

    const bare = new Request("https://www.fluncle.com/api/v1/admin/tracks");

    await expect(adminRole(bare)).resolves.toBeNull();
  });
});
