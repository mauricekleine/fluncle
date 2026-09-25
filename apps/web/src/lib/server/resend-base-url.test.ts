import { describe, expect, it, vi } from "vitest";
import { resolveResendApiUrl } from "./resend";

const RESEND = "https://api.resend.com";
const LOOPBACK = "http://127.0.0.1:9859";

describe("the Resend base URL", () => {
  it("honours a loopback override only in the flagged e2e stack outside production", () => {
    expect(resolveResendApiUrl({ e2e: "1", override: LOOPBACK, production: false })).toBe(LOOPBACK);
  });

  it("always talks to Resend in production, even with the e2e flag and a loopback override", () => {
    expect(resolveResendApiUrl({ e2e: "1", override: LOOPBACK, production: true })).toBe(RESEND);
  });

  it("ignores the override without the e2e flag", () => {
    expect(resolveResendApiUrl({ e2e: undefined, override: LOOPBACK, production: false })).toBe(
      RESEND,
    );
  });

  it("ignores a non-loopback override everywhere", () => {
    expect(
      resolveResendApiUrl({ e2e: "1", override: "https://evil.example", production: false }),
    ).toBe(RESEND);
  });

  it("uses Resend when nothing is set", () => {
    expect(resolveResendApiUrl({ e2e: undefined, override: undefined, production: false })).toBe(
      RESEND,
    );
  });
});

describe("a stray RESEND_API_URL without the e2e flag", () => {
  it("never redirects real email to loopback", async () => {
    vi.resetModules();
    vi.doMock("./env", () => ({
      readEnv: async () => "re_test_key",
      readOptionalEnv: async (key: string) =>
        key === "RESEND_API_URL"
          ? LOOPBACK
          : key === "RESEND_FROM"
            ? "Fluncle <fluncle@example.invalid>"
            : undefined,
    }));

    const fetchMock = vi.fn(
      async (_input: string, _init?: RequestInit) => new Response("{}", { status: 200 }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const { sendMagicLinkEmail } = await import("./resend");

    await sendMagicLinkEmail({ to: "dave@example.com", url: "https://www.fluncle.com/x" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${RESEND}/emails`);

    vi.unstubAllGlobals();
    vi.doUnmock("./env");
  });
});
