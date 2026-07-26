import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_COOKIE_NAME, ADMIN_GRANT_EPOCH_KEY } from "../../../lib/server/env";
import { OPERATOR_TOKEN, setAdminTokenEnv } from "../../../lib/server/orpc-test-kit";

// The OAuth state browser binding, driven END TO END through the real route handlers
// (`serverHandlers`) rather than the helper alone — the wire-up is the thing that was
// missing, so the wire-up is what is asserted.
//
// Two representative legs stand in for all seven:
//   - youtube/auth/{start,callback} — the shape every platform connect shares (a
//     JSON start behind `requireOperator`, a redirect callback that exchanges a code).
//   - spotify/auth/{login,callback} — the ADMIN LOGIN front door, the one that hands
//     out the grant cookie, and the only start route that is public.
//
// The property under test: a browser-started flow's callback refuses the token
// exchange unless the browser presents back the nonce cookie the start leg set, while
// a CLI-started (Bearer) flow keeps working exactly as before.

const SESSION_SECRET = "test-session-secret-oauth-binding";

let epochValue: string | undefined;

vi.mock("../../../lib/server/settings", () => ({
  deleteSetting: async () => {
    epochValue = undefined;
  },
  getSetting: async (key: string) => (key === ADMIN_GRANT_EPOCH_KEY ? epochValue : undefined),
  setSetting: async (key: string, value: string) => {
    if (key === ADMIN_GRANT_EPOCH_KEY) {
      epochValue = value;
    }
  },
}));

const buildYouTubeAuthUrl = vi.fn();
const exchangeCodeForYouTubeToken = vi.fn();

vi.mock("../../../lib/server/youtube", () => ({
  buildYouTubeAuthUrl: (...args: unknown[]) => buildYouTubeAuthUrl(...args),
  exchangeCodeForYouTubeToken: (...args: unknown[]) => exchangeCodeForYouTubeToken(...args),
}));

const buildSpotifyLoginUrl = vi.fn();
const fetchSpotifyProfile = vi.fn();
const exchangeCodeForToken = vi.fn();

vi.mock("../../../lib/server/spotify", () => ({
  buildSpotifyAuthUrl: vi.fn(),
  buildSpotifyLoginUrl: (...args: unknown[]) => buildSpotifyLoginUrl(...args),
  exchangeCodeForToken: (...args: unknown[]) => exchangeCodeForToken(...args),
  fetchSpotifyProfile: (...args: unknown[]) => fetchSpotifyProfile(...args),
}));

const youtubeStart = (await import("./youtube/auth/start")).serverHandlers;
const youtubeCallback = (await import("./youtube/auth/callback")).serverHandlers;
const spotifyLogin = (await import("./spotify/auth/login")).serverHandlers;
const spotifyCallback = (await import("./spotify/auth/callback")).serverHandlers;

const ORIGIN = "https://www.fluncle.com";

beforeAll(() => {
  setAdminTokenEnv();
  process.env.ADMIN_SESSION_SECRET = SESSION_SECRET;
  process.env.ADMIN_ALLOWED_EMAILS = "operator@example.com";
});

beforeEach(() => {
  epochValue = undefined;
  buildYouTubeAuthUrl.mockReset();
  exchangeCodeForYouTubeToken.mockReset();
  buildSpotifyLoginUrl.mockReset();
  fetchSpotifyProfile.mockReset();
  exchangeCodeForToken.mockReset();
});

function handler(handlers: Record<string, unknown>, method: string) {
  const found = handlers[method];

  if (typeof found !== "function") {
    throw new Error(`route is missing its ${method} handler`);
  }

  return found as (context: {
    params: Record<string, string>;
    request: Request;
  }) => Promise<Response>;
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { headers, method: "GET" });
}

/** A real grant cookie header, minted through the production signing path. */
async function grantHeader(): Promise<string> {
  const { signGrant } = await import("../../../lib/server/admin-auth");

  return `${ADMIN_COOKIE_NAME}=${await signGrant()}`;
}

/** `name=value` from a `Set-Cookie`, ready to send back as a `cookie` header. */
function cookiePair(setCookie: null | string): string {
  return (setCookie ?? "").split("; ")[0] ?? "";
}

/** The `state` query param out of the authorize URL the start leg built. */
function stateFromAuthUrl(url: string): string {
  return new URL(url).searchParams.get("state") ?? "";
}

describe("youtube connect — a BROWSER-started flow is bound to that browser", () => {
  async function startInBrowser(): Promise<{ setCookie: null | string; state: string }> {
    buildYouTubeAuthUrl.mockImplementation(
      async (state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    );

    const response = await handler(
      youtubeStart,
      "GET",
    )({
      params: {},
      request: get("/api/v1/admin/youtube/auth/start", { cookie: await grantHeader() }),
    });
    const body = (await response.json()) as { authUrl: string };

    return { setCookie: response.headers.get("Set-Cookie"), state: stateFromAuthUrl(body.authUrl) };
  }

  it("the start leg sets the nonce cookie alongside the authorize URL", async () => {
    const { setCookie, state } = await startInBrowser();

    expect(state).not.toBe("");
    expect(setCookie).toContain("fluncle_oauth_youtube_auth=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("the callback completes when the same browser comes back", async () => {
    const { setCookie, state } = await startInBrowser();

    const response = await handler(
      youtubeCallback,
      "GET",
    )({
      params: {},
      request: get(`/api/admin/youtube/auth/callback?code=abc&state=${state}`, {
        cookie: cookiePair(setCookie),
      }),
    });

    expect(response.status).toBe(302);
    expect(exchangeCodeForYouTubeToken).toHaveBeenCalledWith("abc");
    // The nonce is consumed, so the state cannot be replayed even here.
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("the callback REFUSES a replay from a browser with no nonce cookie", async () => {
    const { state } = await startInBrowser();

    const response = await handler(
      youtubeCallback,
      "GET",
    )({
      params: {},
      request: get(`/api/admin/youtube/auth/callback?code=attacker-code&state=${state}`),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("invalid_state");
    // THE POINT: the attacker's code is never spent, so no foreign token is stored.
    expect(exchangeCodeForYouTubeToken).not.toHaveBeenCalled();
  });

  it("the callback REFUSES a mismatched nonce", async () => {
    const { state } = await startInBrowser();
    const other = await startInBrowser();

    const response = await handler(
      youtubeCallback,
      "GET",
    )({
      params: {},
      request: get(`/api/admin/youtube/auth/callback?code=abc&state=${state}`, {
        cookie: cookiePair(other.setCookie),
      }),
    });

    expect(response.status).toBe(400);
    expect(exchangeCodeForYouTubeToken).not.toHaveBeenCalled();
  });
});

describe("youtube connect — a CLI-started flow keeps working (Bearer, no cookie)", () => {
  it("the start leg sets NO cookie and the callback needs none", async () => {
    buildYouTubeAuthUrl.mockImplementation(
      async (state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    );

    const startResponse = await handler(
      youtubeStart,
      "GET",
    )({
      params: {},
      request: get("/api/v1/admin/youtube/auth/start", {
        Authorization: `Bearer ${OPERATOR_TOKEN}`,
      }),
    });

    expect(startResponse.headers.get("Set-Cookie")).toBeNull();

    const { authUrl } = (await startResponse.json()) as { authUrl: string };
    const callbackResponse = await handler(
      youtubeCallback,
      "GET",
    )({
      params: {},
      request: get(`/api/admin/youtube/auth/callback?code=abc&state=${stateFromAuthUrl(authUrl)}`),
    });

    expect(callbackResponse.status).toBe(302);
    expect(exchangeCodeForYouTubeToken).toHaveBeenCalledWith("abc");
  });
});

describe("admin login — the front door is ALWAYS bound", () => {
  async function login(): Promise<{ setCookie: null | string; state: string }> {
    buildSpotifyLoginUrl.mockImplementation(
      async (state: string) => `https://accounts.spotify.com/authorize?state=${state}`,
    );

    const response = await handler(
      spotifyLogin,
      "GET",
    )({
      params: {},
      request: get("/api/admin/spotify/auth/login"),
    });

    return {
      setCookie: response.headers.get("Set-Cookie"),
      state: stateFromAuthUrl(response.headers.get("Location") ?? ORIGIN),
    };
  }

  it("binds even though the route is public (no Bearer, no grant yet)", async () => {
    const { setCookie, state } = await login();

    expect(state).not.toBe("");
    expect(setCookie).toContain("fluncle_oauth_admin_login=");
  });

  it("hands out the grant when the same browser returns, and clears the nonce", async () => {
    fetchSpotifyProfile.mockResolvedValue({ email: "operator@example.com", id: "op" });

    const { setCookie, state } = await login();
    const response = await handler(
      spotifyCallback,
      "GET",
    )({
      params: {},
      request: get(`/api/admin/spotify/auth/callback?code=abc&state=${state}`, {
        cookie: cookiePair(setCookie),
      }),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/admin");

    const issued = response.headers.getSetCookie();

    expect(issued.some((value) => value.startsWith(`${ADMIN_COOKIE_NAME}=`))).toBe(true);
    expect(
      issued.some(
        (value) => value.startsWith("fluncle_oauth_admin_login=") && value.includes("Max-Age=0"),
      ),
    ).toBe(true);
  });

  it("REFUSES to mint a grant for a replayed login state (no cookie)", async () => {
    fetchSpotifyProfile.mockResolvedValue({ email: "operator@example.com", id: "op" });

    const { state } = await login();
    const response = await handler(
      spotifyCallback,
      "GET",
    )({
      params: {},
      request: get(`/api/admin/spotify/auth/callback?code=abc&state=${state}`),
    });

    expect(response.status).toBe(400);
    // The identity is never read and no grant is issued.
    expect(fetchSpotifyProfile).not.toHaveBeenCalled();
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });
});
