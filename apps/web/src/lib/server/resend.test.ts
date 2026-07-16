import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addContactToSegment,
  createBroadcast,
  sendBroadcast,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "./resend";

// The Resend client is raw `fetch` against the REST API; mock `fetch` + the env
// reads so no real call goes out and assert the endpoints/bodies/idempotency.

vi.mock("./env", () => ({
  readEnv: async (key: string) => {
    if (key === "RESEND_API_KEY") {
      return "re_test_key";
    }
    if (key === "RESEND_SEGMENT_ID") {
      return "seg_fluncle";
    }
    throw new Error(`unexpected readEnv(${key})`);
  },
  readOptionalEnv: async (key: string) =>
    key === "RESEND_FROM" ? "Fluncle <fluncle@newsletter.fluncle.com>" : undefined,
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("addContactToSegment", () => {
  it("creates the contact then attaches it to the Fluncle segment", async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: "cont_1" })).mockResolvedValueOnce(ok());

    await addContactToSegment("raver@example.com");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [createUrl, createInit] = fetchMock.mock.calls[0] ?? [];
    expect(createUrl).toBe("https://api.resend.com/contacts");
    expect(JSON.parse(createInit.body)).toEqual({
      email: "raver@example.com",
      unsubscribed: false,
    });

    const [segUrl] = fetchMock.mock.calls[1] ?? [];
    expect(segUrl).toBe("https://api.resend.com/contacts/raver%40example.com/segments/seg_fluncle");
  });

  it("treats an already-existing contact (409) as success", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 409 }))
      .mockResolvedValueOnce(ok());

    await expect(addContactToSegment("dup@example.com")).resolves.toBeUndefined();
  });

  it("maps a 429 to rate_limited", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 429 }));
    await expect(addContactToSegment("flood@example.com")).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("throws subscribe_failed on an upstream error", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
    );
    await expect(addContactToSegment("err@example.com")).rejects.toMatchObject({
      code: "subscribe_failed",
    });
  });
});

describe("createBroadcast + sendBroadcast", () => {
  it("creates a broadcast to the segment with an idempotency key", async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: "bc_1" }));

    const result = await createBroadcast({
      editionId: "ed_1",
      html: "<p>hi</p>",
      name: "Edition No. 1",
      subject: "Edition No. 1",
    });

    expect(result.id).toBe("bc_1");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.resend.com/broadcasts");
    expect(init.headers["Idempotency-Key"]).toBe("edition-broadcast/ed_1");
    const body = JSON.parse(init.body);
    // Resend's REST API is snake_case — `segment_id`, not `segmentId` (the camelCase
    // key is silently ignored → "Missing segment_id or audience_id" at send time).
    expect(body.segment_id).toBe("seg_fluncle");
    expect(body.segmentId).toBeUndefined();
    expect(body.from).toBe("Fluncle <fluncle@newsletter.fluncle.com>");
  });

  it("sends a broadcast with the send endpoint + idempotency key", async () => {
    fetchMock.mockResolvedValueOnce(ok());

    await sendBroadcast("bc_1");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.resend.com/broadcasts/bc_1/send");
    expect(init.headers["Idempotency-Key"]).toBe("edition-send/bc_1");
  });

  it("passes the schedule through as snake_case scheduled_at on send", async () => {
    fetchMock.mockResolvedValueOnce(ok());

    await sendBroadcast("bc_1", { scheduledAt: "in 1 hour" });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(init.body)).toEqual({ scheduled_at: "in 1 hour" });
  });

  it("throws broadcast_create_failed on a create error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 422 }));
    await expect(
      createBroadcast({ editionId: "ed_x", html: "x", name: "n", subject: "s" }),
    ).rejects.toMatchObject({ code: "broadcast_create_failed" });
  });
});

describe("sendPasswordResetEmail", () => {
  it("sends a single transactional email from the verified sender with the reset link", async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: "email_1" }));

    await sendPasswordResetEmail({
      to: "raver@example.com",
      url: "https://www.fluncle.com/api/auth/reset-password/tok_123",
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(init.body);
    expect(body.from).toBe("Fluncle <fluncle@newsletter.fluncle.com>");
    expect(body.to).toBe("raver@example.com");
    expect(body.subject).toBe("Reset your Fluncle password");
    // The whole link is the literal call to action — it must ride both bodies.
    expect(body.text).toContain("https://www.fluncle.com/api/auth/reset-password/tok_123");
    expect(body.html).toContain("https://www.fluncle.com/api/auth/reset-password/tok_123");
    // Transactional-plain voice: no exclamation marks, no em dashes in the prose.
    expect(body.text).not.toContain("!");
    expect(body.text).not.toContain("—");
  });

  it("throws email_send_failed on an upstream error", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
    );

    await expect(
      sendPasswordResetEmail({ to: "err@example.com", url: "https://www.fluncle.com/x" }),
    ).rejects.toMatchObject({ code: "email_send_failed" });
  });
});

describe("sendVerificationEmail", () => {
  it("sends a single transactional email from the verified sender with the verify link", async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: "email_2" }));

    await sendVerificationEmail({
      to: "raver@example.com",
      url: "https://www.fluncle.com/api/auth/verify-email?token=tok_456&callbackURL=/account",
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(init.body);
    expect(body.from).toBe("Fluncle <fluncle@newsletter.fluncle.com>");
    expect(body.to).toBe("raver@example.com");
    expect(body.subject).toBe("Verify your Fluncle email");
    // The whole link is the literal call to action — it must ride both bodies.
    expect(body.text).toContain("token=tok_456");
    expect(body.html).toContain("token=tok_456");
    // Transactional-plain voice: no exclamation marks, no em dashes in the prose.
    expect(body.text).not.toContain("!");
    expect(body.text).not.toContain("—");
  });

  it("throws email_send_failed on an upstream error", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
    );

    await expect(
      sendVerificationEmail({ to: "err@example.com", url: "https://www.fluncle.com/x" }),
    ).rejects.toMatchObject({ code: "email_send_failed" });
  });
});
