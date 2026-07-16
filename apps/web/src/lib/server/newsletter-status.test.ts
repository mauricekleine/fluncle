import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the env reads so RESEND_API_KEY can be present or absent per test, and stub
// `fetch` so no real Resend call goes out. `readNewsletterStatus` degrades to
// `{ available: false }` whenever the key is missing or the read faults.
const readOptionalEnv = vi.hoisted(() => vi.fn());

vi.mock("./env", () => ({ readOptionalEnv }));

import { parseNewsletterStatus, readNewsletterStatus } from "./newsletter-status";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  readOptionalEnv.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function resendResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("parseNewsletterStatus", () => {
  it("reads a 200 contact as subscribed unless it is unsubscribed", () => {
    expect(parseNewsletterStatus(200, { unsubscribed: false })).toEqual({ subscribed: true });
    expect(parseNewsletterStatus(200, { unsubscribed: true })).toEqual({ subscribed: false });
    // A 200 with no `unsubscribed` field is treated as subscribed (not unsubscribed).
    expect(parseNewsletterStatus(200, undefined)).toEqual({ subscribed: true });
  });

  it("reads a 404 as not-a-contact (not subscribed)", () => {
    expect(parseNewsletterStatus(404, undefined)).toEqual({ subscribed: false });
  });

  it("reads any other status as an error (the caller degrades)", () => {
    expect(parseNewsletterStatus(401, undefined)).toBe("error");
    expect(parseNewsletterStatus(429, undefined)).toBe("error");
    expect(parseNewsletterStatus(500, undefined)).toBe("error");
  });
});

describe("readNewsletterStatus", () => {
  it("hides the row (available:false) and never calls Resend when the API key is absent", async () => {
    readOptionalEnv.mockResolvedValue(undefined);

    await expect(readNewsletterStatus("raver@example.com")).resolves.toEqual({ available: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports subscribed for a present, not-unsubscribed contact", async () => {
    readOptionalEnv.mockResolvedValue("re_test_key");
    fetchMock.mockResolvedValue(
      resendResponse(200, { email: "raver@example.com", unsubscribed: false }),
    );

    await expect(readNewsletterStatus("raver@example.com")).resolves.toEqual({
      available: true,
      subscribed: true,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/contacts/raver%40example.com");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key");
  });

  it("reports not-subscribed for an unsubscribed contact and for a 404", async () => {
    readOptionalEnv.mockResolvedValue("re_test_key");
    fetchMock.mockResolvedValueOnce(resendResponse(200, { unsubscribed: true }));

    await expect(readNewsletterStatus("raver@example.com")).resolves.toEqual({
      available: true,
      subscribed: false,
    });

    fetchMock.mockResolvedValueOnce(resendResponse(404, { name: "not_found" }));

    await expect(readNewsletterStatus("ghost@example.com")).resolves.toEqual({
      available: true,
      subscribed: false,
    });
  });

  it("degrades to available:false on an upstream error or a thrown fetch", async () => {
    readOptionalEnv.mockResolvedValue("re_test_key");
    fetchMock.mockResolvedValueOnce(resendResponse(500, { name: "server_error" }));

    await expect(readNewsletterStatus("raver@example.com")).resolves.toEqual({ available: false });

    fetchMock.mockRejectedValueOnce(new Error("network down"));

    await expect(readNewsletterStatus("raver@example.com")).resolves.toEqual({ available: false });
  });
});
