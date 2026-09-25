import { beforeEach, describe, expect, it, vi } from "vitest";
import { call } from "@orpc/server";

const requirePublicUser = vi.fn();
const requireAccountMutation = vi.fn();

vi.mock("./public-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./public-auth")>();

  return {
    ...actual,
    requirePublicUser: (...args: unknown[]) => requirePublicUser(...args),
  };
});

vi.mock("./account-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./account-data")>();

  return {
    ...actual,
    requireAccountMutation: (...args: unknown[]) => requireAccountMutation(...args),
  };
});

const USER = {
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "user-1",
  username: "fan",
};

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ code, message, ok: false }, { status });
}

function request(): Request {
  return new Request("https://www.fluncle.com/api/v1/me/saved-findings", { method: "GET" });
}

async function invoke(
  procedure: unknown,
  input: unknown = {},
): Promise<{ status?: number; code?: string; message?: string; user?: unknown }> {
  try {
    const result = (await call(procedure as Parameters<typeof call>[0], input, {
      context: { request: request() },
    })) as { user?: unknown };

    return { user: result.user };
  } catch (error) {
    const fault = error as { status?: number; data?: { apiCode?: string; apiMessage?: string } };

    return { code: fault.data?.apiCode, message: fault.data?.apiMessage, status: fault.status };
  }
}

beforeEach(() => {
  requirePublicUser.mockReset();
  requireAccountMutation.mockReset();
});

describe("privateUserAuth (= requirePublicUser, the /me read tier)", () => {
  it("401s with the live auth_required body when there is no session", async () => {
    requirePublicUser.mockResolvedValueOnce(
      jsonError(401, "auth_required", "Sign in to use this private account route"),
    );

    const { privateUserAuth } = await import("./orpc-auth");
    const { os } = await import("@orpc/server");
    const procedure = os
      .$context<{ request: Request }>()
      .use(privateUserAuth)
      .handler(({ context }) => ({ user: context.user }));

    expect(await invoke(procedure)).toEqual({
      code: "auth_required",
      message: "Sign in to use this private account route",
      status: 401,
    });
  });

  it("passes a valid session, injecting context.user", async () => {
    requirePublicUser.mockResolvedValueOnce(USER);

    const { privateUserAuth } = await import("./orpc-auth");
    const { os } = await import("@orpc/server");
    const procedure = os
      .$context<{ request: Request }>()
      .use(privateUserAuth)
      .handler(({ context }) => ({ user: context.user }));

    expect(await invoke(procedure)).toEqual({ user: USER });
  });
});

describe("privateUserMutation (= requireAccountMutation, the /me CSRF write tier)", () => {
  it("passes a valid mutation, injecting context.user and using the op's action/limit", async () => {
    requireAccountMutation.mockResolvedValueOnce(USER);

    const { privateUserMutation } = await import("./orpc-auth");
    const { os } = await import("@orpc/server");
    const procedure = os
      .$context<{ request: Request }>()
      .use(privateUserMutation({ action: "account.saved.write", limit: 90 }))
      .handler(({ context }) => ({ user: context.user }));

    expect(await invoke(procedure)).toEqual({ user: USER });
    expect(requireAccountMutation.mock.calls[0]?.[1]).toEqual({
      action: "account.saved.write",
      limit: 90,
    });
  });

  it.each([
    [415, "invalid_content_type", "Expected application/json"],
    [403, "invalid_origin", "Invalid request origin"],
    [403, "csrf_required", "Invalid account mutation token"],
    [429, "rate_limited", "Too many requests. Try again later."],
    [401, "auth_required", "Sign in to use this private account route"],
  ])("lifts the %i %s guard Response onto the matching fault", async (status, code, message) => {
    requireAccountMutation.mockResolvedValueOnce(jsonError(status, code, message));

    const { privateUserMutation } = await import("./orpc-auth");
    const { os } = await import("@orpc/server");
    const procedure = os
      .$context<{ request: Request }>()
      .use(privateUserMutation({ action: "account.saved.write", limit: 90 }))
      .handler(({ context }) => ({ user: context.user }));

    expect(await invoke(procedure)).toEqual({ code, message, status });
  });
});
