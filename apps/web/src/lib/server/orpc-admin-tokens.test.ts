import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readJson } from "./orpc-test-helpers";

// The admin wave's `admin-tokens` parity + auth proof, driven end-to-end through
// `handleOrpc`. ALL four ops are operator tier (live `requireOperator`): the agent
// is a 403, a non-admin a 401, the operator passes. The two YouTube/Mixcloud token
// mints + the Last.fm `auth/start` are bodyless; `auth/session` validates `token`.

const getYouTubeAccessToken = vi.fn();
const getMixcloudAccessToken = vi.fn();
const lastfmGetToken = vi.fn();
const lastfmGetSession = vi.fn();

vi.mock("./youtube", () => ({
  getYouTubeAccessToken: (...args: unknown[]) => getYouTubeAccessToken(...args),
}));

vi.mock("./mixcloud", () => ({
  getMixcloudAccessToken: (...args: unknown[]) => getMixcloudAccessToken(...args),
}));

vi.mock("./lastfm", () => ({
  lastfmGetSession: (...args: unknown[]) => lastfmGetSession(...args),
  lastfmGetToken: (...args: unknown[]) => lastfmGetToken(...args),
}));

const OPERATOR_TOKEN = "test-token-admin-operator";
const AGENT_TOKEN = "test-token-admin-agent";

beforeAll(() => {
  process.env.FLUNCLE_API_TOKEN = OPERATOR_TOKEN;
  process.env.FLUNCLE_AGENT_TOKEN = AGENT_TOKEN;
});

beforeEach(() => {
  getYouTubeAccessToken.mockReset();
  getMixcloudAccessToken.mockReset();
  lastfmGetToken.mockReset();
  lastfmGetSession.mockReset();
});

function req(path: string, method: string, token: string | undefined, body?: unknown): Request {
  const headers: Record<string, string> = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  return new Request(`https://www.fluncle.com/api/v1${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    method,
  });
}

// ── mint_youtube_token — operator tier ───────────────────────────────────────
describe("oRPC mint_youtube_token (POST /admin/youtube/token)", () => {
  it("401s with no token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/youtube/token", "POST", undefined));

    expect(response?.status).toBe(401);
    expect(getYouTubeAccessToken).not.toHaveBeenCalled();
  });

  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/youtube/token", "POST", AGENT_TOKEN));

    expect(response?.status).toBe(403);
    expect(getYouTubeAccessToken).not.toHaveBeenCalled();
  });

  it("mints for the operator and returns the live envelope", async () => {
    getYouTubeAccessToken.mockResolvedValueOnce("yt-tok");

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/youtube/token", "POST", OPERATOR_TOKEN));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ accessToken: "yt-tok", ok: true });
  });
});

// ── mint_mixcloud_token — operator tier ──────────────────────────────────────
describe("oRPC mint_mixcloud_token (POST /admin/mixcloud/token)", () => {
  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/mixcloud/token", "POST", AGENT_TOKEN));

    expect(response?.status).toBe(403);
    expect(getMixcloudAccessToken).not.toHaveBeenCalled();
  });

  it("mints for the operator and returns the live envelope", async () => {
    getMixcloudAccessToken.mockResolvedValueOnce("mc-tok");

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/mixcloud/token", "POST", OPERATOR_TOKEN));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ accessToken: "mc-tok", ok: true });
  });
});

// ── start_lastfm_auth — operator tier ────────────────────────────────────────
describe("oRPC start_lastfm_auth (GET /admin/lastfm/auth/start)", () => {
  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/lastfm/auth/start", "GET", AGENT_TOKEN));

    expect(response?.status).toBe(403);
    expect(lastfmGetToken).not.toHaveBeenCalled();
  });

  it("returns the request token + authorize URL for the operator", async () => {
    lastfmGetToken.mockResolvedValueOnce({ authUrl: "https://last.fm/auth", token: "rt-1" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/admin/lastfm/auth/start", "GET", OPERATOR_TOKEN));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      authUrl: "https://last.fm/auth",
      ok: true,
      token: "rt-1",
    });
  });
});

// ── exchange_lastfm_session — operator tier ──────────────────────────────────
describe("oRPC exchange_lastfm_session (POST /admin/lastfm/auth/session)", () => {
  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/lastfm/auth/session", "POST", AGENT_TOKEN, { token: "rt-1" }),
    );

    expect(response?.status).toBe(403);
    expect(lastfmGetSession).not.toHaveBeenCalled();
  });

  it("400s `invalid_request` for a missing/blank token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/lastfm/auth/session", "POST", OPERATOR_TOKEN, { token: "   " }),
    );

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code: string }).code).toBe("invalid_request");
    expect(lastfmGetSession).not.toHaveBeenCalled();
  });

  it("exchanges for the operator and returns the live envelope", async () => {
    lastfmGetSession.mockResolvedValueOnce({ name: "fluncle", sessionKey: "sk-1" });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      req("/admin/lastfm/auth/session", "POST", OPERATOR_TOKEN, { token: "rt-1" }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ name: "fluncle", ok: true, sessionKey: "sk-1" });
    expect(lastfmGetSession).toHaveBeenCalledWith("rt-1");
  });
});
