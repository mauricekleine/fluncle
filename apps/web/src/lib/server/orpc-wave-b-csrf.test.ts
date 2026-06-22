import { beforeEach, describe, expect, it, vi } from "vitest";
import { readJson } from "./orpc-test-helpers";

// Wave B — the CSRF/origin guard ORDERING proof for the `/me` mutation tier.
// Unlike orpc-wave-b.test.ts (which stubs `requireAccountMutation` wholesale to
// pin per-op bodies), this drives the REAL `requireAccountMutation` →
// `requireJsonMutation` guard through `handleOrpc`, stubbing only the session
// resolver. It proves the live route's SECURITY guards (origin 403, CSRF 403)
// survive the oRPC framing: they fire from the middleware BEFORE the handler runs
// (no DB touched, no `saveFinding`), with the exact live `jsonError` body.
//
// These two guards run before `enforceRateLimit`, so they never reach Turso —
// which is why they are testable here without a DB. (The happy path and the
// rate-limit 429 both go through the real `enforceRateLimit`, an intra-module
// call vitest can't intercept, so those are covered in orpc-wave-b.test.ts via
// the stubbed `requireAccountMutation`, and by account-data.test.ts directly.)
//
// CONTENT-TYPE DEVIATION (documented): the live route returns 415
// `invalid_content_type` for a non-JSON body; oRPC's OpenAPIHandler decodes the
// request body to build the input BEFORE the procedure middleware runs, so a
// non-JSON body to this JSON-only endpoint is rejected one step earlier as a 400
// `invalid_request`. Both reject the same bad request; only the code/status
// differ. The web client always sends `application/json`, and the auth/CSRF
// controls below are unaffected. Asserted explicitly so the deviation is pinned.

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

    // oRPC decodes the body before the middleware, so the non-JSON body is a 400
    // `invalid_request` (the rails' BAD_REQUEST mapping), not the live 415
    // `invalid_content_type`. The request is rejected either way; the handler
    // never runs.
    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code?: string }).code).toBe("invalid_request");
    expect(saveFinding).not.toHaveBeenCalled();
  });
});
