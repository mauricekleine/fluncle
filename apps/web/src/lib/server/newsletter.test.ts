import { beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeToNewsletter } from "./newsletter";

const addContactToSegment = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./resend", () => ({ addContactToSegment }));
vi.mock("./public-auth", () => ({ getPublicSession: async () => undefined }));
vi.mock("./rate-limit", () => ({ assertRateLimit: async () => undefined }));

function request(): Request {
  return new Request("https://www.fluncle.com/api/newsletter", { method: "POST" });
}

describe("subscribeToNewsletter — Resend repoint", () => {
  beforeEach(() => {
    addContactToSegment.mockClear();
  });

  it("adds a valid email to the Resend segment (lower-cased, trimmed)", async () => {
    await subscribeToNewsletter({ email: "  Raver@Example.com " }, request());

    expect(addContactToSegment).toHaveBeenCalledWith("raver@example.com");
  });

  it("rejects an invalid email before touching Resend", async () => {
    await expect(subscribeToNewsletter({ email: "nope" }, request())).rejects.toMatchObject({
      code: "invalid_email",
    });
    expect(addContactToSegment).not.toHaveBeenCalled();
  });

  it("rejects a tripped honeypot before touching Resend", async () => {
    await expect(
      subscribeToNewsletter({ email: "raver@example.com", honeypot: "bot" }, request()),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(addContactToSegment).not.toHaveBeenCalled();
  });
});
