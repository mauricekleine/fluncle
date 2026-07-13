import { afterEach, describe, expect, it } from "vitest";

import { type FetchImpl } from "./env";
import { refreshInstagramToken } from "./instagram";
import { requestTiktokToken } from "./tiktok";
import { requestTwitchToken } from "./twitch";

// The Tier-2 token-REFRESH path (docs/reach-tier2-activation.md), fetch mocked so no
// real network + no DB is touched. Each platform's raw token helper (twitch/tiktok are
// POSTs; instagram is a GET) is the DB-free core the DB-backed `get<Platform>AccessToken`
// calls when the stored token nears expiry — this exercises that core: it parses the
// refreshed token out of the response, throws a clean reason on a fault, and (twitch/
// tiktok) throws a "not configured" error when the client creds are unset.

/** A fake `fetch` that answers by URL SUBSTRING and records the calls it saw. */
function recordingFetch(routes: { body: unknown; match: string; status?: number }[]): {
  calls: { body: string | null; url: string }[];
  fetchImpl: FetchImpl;
} {
  const calls: { body: string | null; url: string }[] = [];
  const fetchImpl = ((input: URL | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.href;
    // Every token POST sends a URLSearchParams body; narrow so the linter has a concrete
    // stringifiable type (no-base-to-string), else fall back to a raw string body.
    const rawBody = init?.body;
    const body =
      rawBody instanceof URLSearchParams
        ? rawBody.toString()
        : typeof rawBody === "string"
          ? rawBody
          : null;
    calls.push({ body, url });
    const route = routes.find((entry) => url.includes(entry.match));

    if (!route) {
      throw new Error(`unexpected fetch: ${url}`);
    }

    return Promise.resolve(
      new Response(JSON.stringify(route.body), { status: route.status ?? 200 }),
    );
  }) as FetchImpl;

  return { calls, fetchImpl };
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("requestTwitchToken (refresh path)", () => {
  it("posts the refresh grant with the client creds and parses the new tokens", async () => {
    process.env.TWITCH_CLIENT_ID = "twitch-id";
    process.env.TWITCH_CLIENT_SECRET = "twitch-secret";

    const { calls, fetchImpl } = recordingFetch([
      {
        body: {
          access_token: "new-access",
          expires_in: 15485,
          refresh_token: "new-refresh",
          scope: ["moderator:read:followers"],
        },
        match: "id.twitch.tv/oauth2/token",
      },
    ]);

    const data = await requestTwitchToken(
      { grant_type: "refresh_token", refresh_token: "old-refresh" },
      fetchImpl,
    );

    expect(data.access_token).toBe("new-access");
    expect(data.refresh_token).toBe("new-refresh");
    expect(calls[0]?.body).toContain("grant_type=refresh_token");
    expect(calls[0]?.body).toContain("client_id=twitch-id");
    expect(calls[0]?.body).toContain("refresh_token=old-refresh");
  });

  it("throws a not-configured error when the client creds are unset", async () => {
    delete process.env.TWITCH_CLIENT_ID;
    delete process.env.TWITCH_CLIENT_SECRET;

    await expect(
      requestTwitchToken(
        { grant_type: "refresh_token", refresh_token: "x" },
        recordingFetch([]).fetchImpl,
      ),
    ).rejects.toThrow(/not configured/);
  });

  it("throws on a non-2xx token response", async () => {
    process.env.TWITCH_CLIENT_ID = "twitch-id";
    process.env.TWITCH_CLIENT_SECRET = "twitch-secret";

    await expect(
      requestTwitchToken(
        { grant_type: "refresh_token", refresh_token: "old" },
        recordingFetch([{ body: { message: "invalid" }, match: "oauth2/token", status: 401 }])
          .fetchImpl,
      ),
    ).rejects.toThrow(/Twitch token request failed/);
  });
});

describe("requestTiktokToken (refresh path)", () => {
  it("posts the refresh grant with client_key and parses the new tokens", async () => {
    process.env.TIKTOK_CLIENT_KEY = "tiktok-key";
    process.env.TIKTOK_CLIENT_SECRET = "tiktok-secret";

    const { calls, fetchImpl } = recordingFetch([
      {
        body: {
          access_token: "new-access",
          expires_in: 86400,
          refresh_token: "new-refresh",
          scope: "user.info.basic,user.info.stats",
        },
        match: "open.tiktokapis.com/v2/oauth/token",
      },
    ]);

    const data = await requestTiktokToken(
      { grant_type: "refresh_token", refresh_token: "old-refresh" },
      fetchImpl,
    );

    expect(data.access_token).toBe("new-access");
    expect(data.refresh_token).toBe("new-refresh");
    expect(calls[0]?.body).toContain("client_key=tiktok-key");
    expect(calls[0]?.body).toContain("grant_type=refresh_token");
  });

  it("throws when TikTok reports an error in the body (a 200 with error set)", async () => {
    process.env.TIKTOK_CLIENT_KEY = "tiktok-key";
    process.env.TIKTOK_CLIENT_SECRET = "tiktok-secret";

    await expect(
      requestTiktokToken(
        { grant_type: "refresh_token", refresh_token: "old" },
        recordingFetch([
          {
            body: { error: "invalid_grant", error_description: "refresh token expired" },
            match: "oauth/token",
          },
        ]).fetchImpl,
      ),
    ).rejects.toThrow(/refresh token expired/);
  });
});

describe("refreshInstagramToken", () => {
  it("GETs the ig_refresh_token grant and parses the refreshed long-lived token", async () => {
    const { calls, fetchImpl } = recordingFetch([
      {
        body: { access_token: "refreshed-long-token", expires_in: 5183944, token_type: "bearer" },
        match: "graph.instagram.com/refresh_access_token",
      },
    ]);

    const data = await refreshInstagramToken("current-long-token", fetchImpl);

    expect(data.access_token).toBe("refreshed-long-token");
    expect(data.expires_in).toBe(5183944);
    // No client secret in the refresh — the current token authorizes it.
    expect(calls[0]?.url).toContain("grant_type=ig_refresh_token");
    expect(calls[0]?.url).toContain("access_token=current-long-token");
  });

  it("throws on a non-200 refresh response", async () => {
    await expect(
      refreshInstagramToken(
        "expired",
        recordingFetch([{ body: { error: {} }, match: "refresh_access_token", status: 400 }])
          .fetchImpl,
      ),
    ).rejects.toThrow(/Instagram token refresh failed/);
  });
});
