import { beforeEach, describe, expect, it, vi } from "vitest";

const enforceRateLimit = vi.fn<(input: { action: string }) => Promise<Response | undefined>>();
const consumeRateLimit = vi.fn<(input: { action: string; bucket: string }) => Promise<boolean>>();

vi.mock("./rate-limit", () => ({
  consumeRateLimit: (input: { action: string; bucket: string }) => consumeRateLimit(input),
  enforceRateLimit: (input: { action: string }) => enforceRateLimit(input),
}));

const { authRateLimit, MAGIC_LINK_LIMIT_PER_EMAIL } = await import("./auth-rate-limit");

function magicLinkRequest(email: string): Request {
  return new Request("https://www.fluncle.com/api/auth/sign-in/magic-link", {
    body: JSON.stringify({ callbackURL: "/account", email }),
    headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    method: "POST",
  });
}

beforeEach(() => {
  enforceRateLimit.mockReset();
  enforceRateLimit.mockResolvedValue(undefined);
  consumeRateLimit.mockReset();
  consumeRateLimit.mockResolvedValue(true);
});

describe("magic-link rate limit", () => {
  it("charges the address as well as the IP, bucketed by a hash of the normalised email", async () => {
    const request = magicLinkRequest("  Jade@Example.com ");

    expect(await authRateLimit(request)).toBeUndefined();
    expect(enforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.magic-link" }),
    );

    const [charge] = consumeRateLimit.mock.calls[0] ?? [];

    expect(charge?.action).toBe("auth.magic-link.email");
    expect(charge?.bucket).not.toContain("jade");
    expect(charge).toEqual(expect.objectContaining({ limit: MAGIC_LINK_LIMIT_PER_EMAIL }));

    await authRateLimit(magicLinkRequest("jade@example.com"));

    expect(consumeRateLimit.mock.calls[1]?.[0]?.bucket).toBe(charge?.bucket);
  });

  it("refuses once the address is over its hourly budget and leaves the body readable", async () => {
    consumeRateLimit.mockResolvedValue(false);
    const request = magicLinkRequest("jade@example.com");
    const limited = await authRateLimit(request);

    expect(limited?.status).toBe(429);
    expect(((await request.json()) as { email: string }).email).toBe("jade@example.com");
  });

  it("stops at the IP limit before reading the address", async () => {
    enforceRateLimit.mockResolvedValue(new Response(null, { status: 429 }));

    expect((await authRateLimit(magicLinkRequest("jade@example.com")))?.status).toBe(429);
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });

  it("leaves other auth paths on their own limits", async () => {
    await authRateLimit(
      new Request("https://www.fluncle.com/api/auth/sign-in/email", { method: "POST" }),
    );

    expect(enforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.signin" }),
    );
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });
});
