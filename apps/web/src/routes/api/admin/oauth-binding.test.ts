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
//   - oauth/handoff — the CLI's front door, which turns a Bearer-carried start into a
//     browser-minted flow so there is no unbound state left anywhere.
//
// The property under test: a callback refuses the token exchange unless the browser
// presents back the nonce cookie the start leg set — and EVERY flow is now such a
// flow. A Bearer-carried start no longer receives a provider URL at all; it receives a
// handoff link that mints the state inside the operator's browser.

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

// A PARTIAL mock: the four network-touching functions are faked, but everything else
// — crucially `ApiError`, which `http-errors.ts` imports from here and `instanceof`s —
// stays real. A whole-module mock left `ApiError` undefined, which turned any error
// path through `apiErrorResponse` into a TypeError instead of the clean 400 it is.
vi.mock("../../../lib/server/spotify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/server/spotify")>()),
  buildSpotifyAuthUrl: vi.fn(),
  buildSpotifyLoginUrl: (...args: unknown[]) => buildSpotifyLoginUrl(...args),
  exchangeCodeForToken: (...args: unknown[]) => exchangeCodeForToken(...args),
  fetchSpotifyProfile: (...args: unknown[]) => fetchSpotifyProfile(...args),
}));

const youtubeStart = (await import("./youtube/auth/start")).serverHandlers;
const youtubeCallback = (await import("./youtube/auth/callback")).serverHandlers;
const spotifyLogin = (await import("./spotify/auth/login")).serverHandlers;
const spotifyCallback = (await import("./spotify/auth/callback")).serverHandlers;
const oauthHandoff = (await import("./oauth/handoff")).serverHandlers;
const { handoffUrl, mintHandoffTicket } = await import("../../../lib/server/oauth-handoff");

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

describe("youtube connect — a CLI-started flow is handed off, never left unbound", () => {
  /** `fluncle admin auth youtube`: a Bearer start, and the link it prints. */
  async function startFromCli(): Promise<Response> {
    return handler(
      youtubeStart,
      "GET",
    )({
      params: {},
      request: get("/api/v1/admin/youtube/auth/start", {
        Authorization: `Bearer ${OPERATOR_TOKEN}`,
      }),
    });
  }

  it("the start leg returns a FLUNCLE link and mints no state at all", async () => {
    const response = await startFromCli();
    const { authUrl } = (await response.json()) as { authUrl: string };
    const url = new URL(authUrl);

    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe("/api/v1/admin/oauth/handoff");
    // Nothing to bind and nothing to replay: no state is signed and no cookie set
    // until a browser asks for one.
    expect(response.headers.get("Set-Cookie")).toBeNull();
    // The builder runs ONLY as the config pre-flight, on an empty state that is
    // discarded — so an unconfigured platform still 400s at the CLI.
    expect(buildYouTubeAuthUrl).toHaveBeenCalledWith("");
  });

  it("an UNCONFIGURED platform still 400s at the CLI instead of printing a dead link", async () => {
    const { ApiError } = await import("../../../lib/server/spotify");

    buildYouTubeAuthUrl.mockRejectedValue(
      new ApiError("youtube_not_configured", "YouTube OAuth is not configured", 400),
    );

    const response = await startFromCli();

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("youtube_not_configured");
  });

  it("opening that link in the admin browser mints a BOUND state and redirects on", async () => {
    buildYouTubeAuthUrl.mockImplementation(
      async (state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    );

    const { authUrl } = (await (await startFromCli()).json()) as { authUrl: string };
    const response = await handler(
      oauthHandoff,
      "GET",
    )({
      params: {},
      request: new Request(authUrl, { headers: { cookie: await grantHeader() }, method: "GET" }),
    });

    expect(response.status).toBe(302);

    const location = response.headers.get("Location") ?? "";
    const state = stateFromAuthUrl(location);
    const setCookie = response.headers.get("Set-Cookie");

    expect(location).toContain("https://accounts.google.com");
    expect(setCookie).toContain("fluncle_oauth_youtube_auth=");

    // And the callback then behaves exactly like a browser start's: bound.
    const completed = await handler(
      youtubeCallback,
      "GET",
    )({
      params: {},
      request: get(`/api/admin/youtube/auth/callback?code=abc&state=${state}`, {
        cookie: cookiePair(setCookie),
      }),
    });

    expect(completed.status).toBe(302);
    expect(exchangeCodeForYouTubeToken).toHaveBeenCalledWith("abc");
  });

  it("the state the handoff mints is REPLAY-PROOF in another browser", async () => {
    buildYouTubeAuthUrl.mockImplementation(
      async (state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    );

    const { authUrl } = (await (await startFromCli()).json()) as { authUrl: string };
    const handed = await handler(
      oauthHandoff,
      "GET",
    )({
      params: {},
      request: new Request(authUrl, { headers: { cookie: await grantHeader() }, method: "GET" }),
    });
    const state = stateFromAuthUrl(handed.headers.get("Location") ?? "");

    // THE RESIDUAL, GONE: this is the exact replay the old `bind: "none"` allowed.
    const response = await handler(
      youtubeCallback,
      "GET",
    )({
      params: {},
      request: get(`/api/admin/youtube/auth/callback?code=attacker-code&state=${state}`),
    });

    expect(response.status).toBe(400);
    expect(exchangeCodeForYouTubeToken).not.toHaveBeenCalled();
  });

  it("a LEAKED handoff link without the grant cookie mints nothing — it bounces to login", async () => {
    const { authUrl } = (await (await startFromCli()).json()) as { authUrl: string };
    const ticket = new URL(authUrl).searchParams.get("token") ?? "";

    // Discount the start leg's config pre-flight, so what follows measures the
    // handoff alone.
    buildYouTubeAuthUrl.mockClear();

    const response = await handler(
      oauthHandoff,
      "GET",
    )({ params: {}, request: new Request(authUrl, { method: "GET" }) });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `/admin/login?handoff=${encodeURIComponent(ticket)}`,
    );
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(buildYouTubeAuthUrl).not.toHaveBeenCalled();
  });

  it("a BEARER token cannot substitute for the grant cookie on the handoff", async () => {
    const { authUrl } = (await (await startFromCli()).json()) as { authUrl: string };

    buildYouTubeAuthUrl.mockClear();

    const response = await handler(
      oauthHandoff,
      "GET",
    )({
      params: {},
      request: new Request(authUrl, {
        headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` },
        method: "GET",
      }),
    });

    // A Bearer caller is exactly the carrier that cannot hold the nonce cookie, so
    // authenticating as the operator is NOT enough here — only the browser is.
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/admin/login");
    expect(buildYouTubeAuthUrl).not.toHaveBeenCalled();
  });

  it("refuses an expired ticket, and refuses a bad one BEFORE it checks the cookie", async () => {
    const ticket = await mintHandoffTicket("youtube-auth");

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);

    const expired = await handler(
      oauthHandoff,
      "GET",
    )({
      params: {},
      request: new Request(handoffUrl(ORIGIN, ticket), {
        headers: { cookie: await grantHeader() },
        method: "GET",
      }),
    });

    vi.useRealTimers();

    expect(expired.status).toBe(400);
    expect(((await expired.json()) as { code: string }).code).toBe("invalid_handoff");

    // A garbage ticket with NO cookie must also answer 400 rather than the login
    // bounce — the bounce would tell an anonymous caller their ticket was good.
    const garbage = await handler(
      oauthHandoff,
      "GET",
    )({ params: {}, request: get("/api/v1/admin/oauth/handoff?token=nope") });

    expect(garbage.status).toBe(400);
  });
});

describe("the login round trip — a handoff opened while signed out comes back", () => {
  it("carries the ticket through login and lands the operator back on the connect", async () => {
    fetchSpotifyProfile.mockResolvedValue({ email: "operator@example.com", id: "op" });
    buildSpotifyLoginUrl.mockImplementation(
      async (state: string) => `https://accounts.spotify.com/authorize?state=${state}`,
    );

    const ticket = await mintHandoffTicket("youtube-auth");
    const login = await handler(
      spotifyLogin,
      "GET",
    )({
      params: {},
      request: get(`/api/admin/spotify/auth/login?handoff=${encodeURIComponent(ticket)}`),
    });
    const state = stateFromAuthUrl(login.headers.get("Location") ?? ORIGIN);

    const response = await handler(
      spotifyCallback,
      "GET",
    )({
      params: {},
      request: get(`/api/admin/spotify/auth/callback?code=abc&state=${state}`, {
        cookie: cookiePair(login.headers.get("Set-Cookie")),
      }),
    });

    expect(response.status).toBe(302);
    // A FIXED path rebuilt from a ticket Fluncle signed — never a caller-supplied URL.
    expect(response.headers.get("Location")).toBe(
      `/api/v1/admin/oauth/handoff?token=${encodeURIComponent(ticket)}`,
    );
  });

  it("DROPS an unverifiable ticket and lands on /admin (no open redirect)", async () => {
    fetchSpotifyProfile.mockResolvedValue({ email: "operator@example.com", id: "op" });
    buildSpotifyLoginUrl.mockImplementation(
      async (state: string) => `https://accounts.spotify.com/authorize?state=${state}`,
    );

    const login = await handler(
      spotifyLogin,
      "GET",
    )({
      params: {},
      request: get("/api/admin/spotify/auth/login?handoff=https://evil.example.com"),
    });
    const state = stateFromAuthUrl(login.headers.get("Location") ?? ORIGIN);

    const response = await handler(
      spotifyCallback,
      "GET",
    )({
      params: {},
      request: get(`/api/admin/spotify/auth/callback?code=abc&state=${state}`, {
        cookie: cookiePair(login.headers.get("Set-Cookie")),
      }),
    });

    expect(response.headers.get("Location")).toBe("/admin");
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
