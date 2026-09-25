import { beforeEach, describe, expect, it, vi } from "vitest";
import { readJson, warmOrpcRouter } from "./orpc-test-kit";

const requirePublicUser = vi.fn();
const saveFinding = vi.fn();

vi.mock("./public-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./public-auth")>();

  return {
    ...actual,
    requirePublicUser: (...a: unknown[]) => requirePublicUser(...a),
  };
});

vi.mock("./account-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./account-data")>();

  return {
    ...actual,
    saveFinding: (...a: unknown[]) => saveFinding(...a),
  };
});

const USER = { createdAt: "2026-01-01T00:00:00.000Z", id: "user-1", username: "fan" };
const URL = "https://www.fluncle.com/api/v1/me/saved-findings";

warmOrpcRouter();

beforeEach(() => {
  requirePublicUser.mockReset();
  saveFinding.mockReset();
  requirePublicUser.mockResolvedValue(USER);
});

describe("oRPC /me mutation guard ordering (real requireAccountMutation)", () => {
  it("403s a cross-origin mutation (invalid_origin) from the guard, before the handler", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      new Request(URL, {
        body: JSON.stringify({ trackId: "abc" }),
        headers: { "Content-Type": "application/json", origin: "https://evil.example" },
        method: "POST",
      }),
    );

    expect(response?.status).toBe(403);
    expect(await readJson(response)).toEqual({
      code: "invalid_origin",
      message: "Invalid request origin",
      ok: false,
    });
    expect(saveFinding).not.toHaveBeenCalled();
  });

  it("403s a same-origin mutation with NO CSRF token (csrf_required), before the handler", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      new Request(URL, {
        body: JSON.stringify({ trackId: "abc" }),
        headers: { "Content-Type": "application/json", origin: "https://www.fluncle.com" },
        method: "POST",
      }),
    );

    expect(response?.status).toBe(403);
    expect(await readJson(response)).toEqual({
      code: "csrf_required",
      message: "Invalid account mutation token",
      ok: false,
    });
    expect(saveFinding).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body (the documented 415→400 deviation)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      new Request(URL, {
        body: "trackId=abc",
        headers: { "Content-Type": "text/plain", origin: "https://www.fluncle.com" },
        method: "POST",
      }),
    );

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code?: string }).code).toBe("invalid_request");
    expect(saveFinding).not.toHaveBeenCalled();
  });
});
