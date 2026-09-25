import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const requirePublicUserMock = vi.fn();
const enforceRateLimitMock = vi.fn();
const streamChatMock = vi.fn();

vi.mock("../../lib/server/public-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/server/public-auth")>();

  return {
    ...actual,
    requirePublicUser: (...args: unknown[]) => requirePublicUserMock(...args),
  };
});

vi.mock("../../lib/server/rate-limit", () => ({
  enforceRateLimit: (...args: unknown[]) => enforceRateLimitMock(...args),
}));

vi.mock("../../lib/server/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/server/chat")>();

  return {
    ...actual,
    streamChat: (...args: unknown[]) => streamChatMock(...args),
  };
});

const { serverHandlers } = await import("./chat");
const { createCsrfToken } = await import("../../lib/server/public-auth");
const { MAX_CHAT_MESSAGES } = await import("../../lib/server/chat");

type TestUser = Parameters<typeof createCsrfToken>[0];

const ORIGIN = "https://www.fluncle.com";

function verifiedUser(overrides: Partial<TestUser> = {}): TestUser {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    email: "crew@example.com",
    emailVerified: true,
    id: "user-1",
    name: "Crew Member",
    ...overrides,
  };
}

function chatBody(text = "What have you found on Hospital Records?"): string {
  return JSON.stringify({
    messages: [{ parts: [{ text, type: "text" }], role: "user" }],
  });
}

function request({
  body = chatBody(),
  csrf,
  origin = ORIGIN,
}: {
  body?: string;
  csrf?: string;
  origin?: null | string;
} = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (origin) {
    headers.Origin = origin;
  }

  if (csrf) {
    headers["x-fluncle-csrf"] = csrf;
  }

  return new Request(`${ORIGIN}/api/v1/chat`, { body, headers, method: "POST" });
}

function callPost(req: Request) {
  const handler = serverHandlers.POST;

  if (!handler) {
    throw new Error("chat route is missing its POST handler");
  }

  return handler({ params: {}, request: req });
}

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "chat-route-test-secret";
});

beforeEach(() => {
  requirePublicUserMock.mockReset();
  enforceRateLimitMock.mockReset();
  streamChatMock.mockReset();

  enforceRateLimitMock.mockResolvedValue(undefined);
});

describe("POST /api/chat", () => {
  it("401s an anonymous request before touching anything else", async () => {
    requirePublicUserMock.mockResolvedValue(
      Response.json({ code: "auth_required", ok: false }, { status: 401 }),
    );

    const res = await callPost(request());

    expect(res.status).toBe(401);
    expect(enforceRateLimitMock).not.toHaveBeenCalled();
    expect(streamChatMock).not.toHaveBeenCalled();
  });

  it("403s a signed-in but unverified account (the learning-cohort gate)", async () => {
    requirePublicUserMock.mockResolvedValue(verifiedUser({ emailVerified: false }));

    const res = await callPost(request());
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe("email_unverified");
    expect(enforceRateLimitMock).not.toHaveBeenCalled();
    expect(streamChatMock).not.toHaveBeenCalled();
  });

  it("403s a cross-site origin (the real origin check runs)", async () => {
    const user = verifiedUser();

    requirePublicUserMock.mockResolvedValue(user);

    const res = await callPost(
      request({ csrf: createCsrfToken(user), origin: "https://evil.example.com" }),
    );
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe("invalid_origin");
    expect(streamChatMock).not.toHaveBeenCalled();
  });

  it("403s a missing CSRF token (the real HMAC verification runs)", async () => {
    requirePublicUserMock.mockResolvedValue(verifiedUser());

    const res = await callPost(request());
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe("csrf_required");
    expect(streamChatMock).not.toHaveBeenCalled();
  });

  it("403s another user's CSRF token", async () => {
    requirePublicUserMock.mockResolvedValue(verifiedUser());

    const res = await callPost(request({ csrf: createCsrfToken(verifiedUser({ id: "user-2" })) }));

    expect(res.status).toBe(403);
    expect(streamChatMock).not.toHaveBeenCalled();
  });

  it("429s when the hourly dial closes, keyed on the user, without a model call", async () => {
    const user = verifiedUser();

    requirePublicUserMock.mockResolvedValue(user);
    enforceRateLimitMock.mockResolvedValueOnce(
      Response.json({ code: "rate_limited", ok: false }, { status: 429 }),
    );

    const res = await callPost(request({ csrf: createCsrfToken(user) }));

    expect(res.status).toBe(429);

    expect(enforceRateLimitMock).toHaveBeenCalledTimes(1);
    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "chat.message",
        limit: 30,
        userId: "user-1",
        windowMs: 60 * 60 * 1000,
      }),
    );
    expect(streamChatMock).not.toHaveBeenCalled();
  });

  it("429s when the daily ceiling closes after the hourly dial passes", async () => {
    const user = verifiedUser();

    requirePublicUserMock.mockResolvedValue(user);
    enforceRateLimitMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(Response.json({ code: "rate_limited", ok: false }, { status: 429 }));

    const res = await callPost(request({ csrf: createCsrfToken(user) }));

    expect(res.status).toBe(429);

    expect(enforceRateLimitMock).toHaveBeenCalledTimes(2);
    expect(enforceRateLimitMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "chat.message.daily",
        limit: 150,
        userId: "user-1",
        windowMs: 24 * 60 * 60 * 1000,
      }),
    );
    expect(streamChatMock).not.toHaveBeenCalled();
  });

  it("400s a malformed turn history (the real zod guard runs)", async () => {
    const user = verifiedUser();

    requirePublicUserMock.mockResolvedValue(user);

    const res = await callPost(
      request({ body: JSON.stringify({ messages: [] }), csrf: createCsrfToken(user) }),
    );
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("invalid_messages");
    expect(streamChatMock).not.toHaveBeenCalled();
  });

  it("400s an over-cap turn history without ever reaching the paid model", async () => {
    const user = verifiedUser();

    requirePublicUserMock.mockResolvedValue(user);

    const messages = Array.from({ length: MAX_CHAT_MESSAGES + 1 }, (_, index) => ({
      id: `msg-${index}`,
      parts: [{ text: "hi", type: "text" }],
      role: "user",
    }));
    const res = await callPost(
      request({ body: JSON.stringify({ messages }), csrf: createCsrfToken(user) }),
    );
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("invalid_messages");
    expect(streamChatMock).not.toHaveBeenCalled();
  });

  it("503s honestly when the chat is unprovisioned (no model key)", async () => {
    const user = verifiedUser();

    requirePublicUserMock.mockResolvedValue(user);
    streamChatMock.mockResolvedValue(null);

    const res = await callPost(request({ csrf: createCsrfToken(user) }));
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe("chat_unprovisioned");
  });

  it("streams a turn back untouched once every rail passes", async () => {
    const user = verifiedUser();
    const stream = new Response("data: chunk\n\n", {
      headers: { "Content-Type": "text/event-stream" },
      status: 200,
    });

    requirePublicUserMock.mockResolvedValue(user);
    streamChatMock.mockResolvedValue(stream);

    const res = await callPost(request({ csrf: createCsrfToken(user) }));

    expect(res).toBe(stream);

    expect(streamChatMock).toHaveBeenCalledTimes(1);
    const [messages] = streamChatMock.mock.calls[0] as [
      { parts: { text: string; type: string }[]; role: string }[],
    ];

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");

    expect(enforceRateLimitMock).toHaveBeenCalledTimes(2);
  });
});
