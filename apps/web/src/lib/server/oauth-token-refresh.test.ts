import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: async () => holder.db };
});

import { ApiError } from "./api-error";
import { getInstagramAccessToken } from "./instagram";
import { createIntegrationDb } from "./integration-db";
import { exchangeCodeForMixcloudToken, getMixcloudAccessToken } from "./mixcloud";
import { getTikTokAccessToken, requestTikTokToken } from "./tiktok";
import { getTwitchAccessToken } from "./twitch";
import { getYouTubeAccessToken } from "./youtube";

let db: Client;

const providers = [
  {
    get: getYouTubeAccessToken,
    invalidGrant: { error: "invalid_grant" },
    scope: "youtube.upload",
    service: "youtube",
  },
  {
    get: getTikTokAccessToken,
    invalidGrant: { error: "invalid_grant" },
    scope: "video.list",
    service: "tiktok",
  },
  {
    get: getTwitchAccessToken,
    invalidGrant: { error: "Bad Request", message: "Invalid refresh token" },
    scope: ["moderator:read:followers"],
    service: "twitch",
  },
];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

async function seed(service: string, remainingMs: number): Promise<void> {
  const expiresAt = new Date(Date.now() + remainingMs).toISOString();
  if (service === "instagram") {
    await db.execute({
      args: ["old-access", expiresAt, new Date().toISOString()],
      sql: "insert into instagram_auth (service, access_token, expires_at, updated_at) values ('instagram', ?, ?, ?)",
    });
    return;
  }
  await db.execute({
    args: [service, "old-access", "old-refresh", expiresAt, "old-scope", new Date().toISOString()],
    sql: `insert into ${service}_auth (service, access_token, refresh_token, expires_at, scope, updated_at) values (?, ?, ?, ?, ?, ?)`,
  });
}

async function read(service: string) {
  return (await db.execute(`select * from ${service}_auth`)).rows[0];
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
  for (const key of [
    "YOUTUBE_CLIENT_ID",
    "YOUTUBE_CLIENT_SECRET",
    "TIKTOK_CLIENT_KEY",
    "TIKTOK_CLIENT_SECRET",
    "TWITCH_CLIENT_ID",
    "TWITCH_CLIENT_SECRET",
    "MIXCLOUD_CLIENT_ID",
    "MIXCLOUD_CLIENT_SECRET",
  ]) {
    vi.stubEnv(key, "test-credential");
  }
});

afterEach(() => {
  db.close();
  holder.db = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe.each(providers)(
  "shared OAuth refresh for $service",
  ({ get, invalidGrant, scope, service }) => {
    it("returns a fresh token without contacting the provider", async () => {
      await seed(service, 600_000);
      const fetchImpl = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchImpl);
      expect(await get()).toBe("old-access");
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("refreshes at the window boundary and persists the rotated token and scope", async () => {
      await seed(service, 60_000);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          json({
            access_token: "new-access",
            expires_in: 3600,
            refresh_token: "new-refresh",
            scope,
          }),
        ),
      );
      const started = Date.now();
      expect(await get()).toBe("new-access");
      const saved = await read(service);
      expect(saved).toMatchObject({
        access_token: "new-access",
        refresh_token: "new-refresh",
        scope: Array.isArray(scope) ? scope.join(" ") : scope,
      });
      if (typeof saved?.expires_at !== "string") {
        throw new Error("Saved authorization has no expiry");
      }
      expect(new Date(saved.expires_at).getTime()).toBeGreaterThanOrEqual(started + 3_600_000);
    });

    it.each(service === "twitch" ? [400, 401] : [400])(
      "uses the concurrent winner after invalid_grant (HTTP %s) without overwriting or clearing it",
      async (status) => {
        await seed(service, -60_000);
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            await db.execute({
              args: ["winner-access", "winner-refresh", service],
              sql: `update ${service}_auth set access_token = ?, refresh_token = ? where service = ?`,
            });
            return json({ ...invalidGrant, status }, status);
          }),
        );
        expect(await get()).toBe("winner-access");
        expect(await read(service)).toMatchObject({
          access_token: "winner-access",
          refresh_token: "winner-refresh",
        });
      },
    );

    it.each(service === "twitch" ? [400, 401] : [400])(
      "clears rejected authorization after invalid_grant (HTTP %s) and raises the reauth ApiError when there is no winner",
      async (status) => {
        await seed(service, -60_000);
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => json({ ...invalidGrant, status }, status)),
        );
        await expect(get()).rejects.toMatchObject({
          code: `${service}_reauth_required`,
          status: 401,
        });
        expect(await read(service)).toBeUndefined();
      },
    );

    it("preserves authorization and the token ApiError for other provider failures", async () => {
      await seed(service, -60_000);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => json({ error: "invalid_client", message: "Invalid client secret" }, 400)),
      );
      await expect(get()).rejects.toBeInstanceOf(ApiError);
      expect(await read(service)).toMatchObject({
        access_token: "old-access",
        refresh_token: "old-refresh",
      });
    });
  },
);

describe("Instagram refresh parity", () => {
  it("keeps the old token and row when the refresh response omits access_token", async () => {
    await seed("instagram", -60_000);
    const before = await read("instagram");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ expires_in: 3600 })),
    );
    expect(await getInstagramAccessToken()).toBe("old-access");
    expect(await read("instagram")).toEqual(before);
  });

  it("refreshes within its one-day window and persists the new token", async () => {
    await seed("instagram", 12 * 60 * 60 * 1000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ access_token: "new-access", expires_in: 3600 })),
    );
    expect(await getInstagramAccessToken()).toBe("new-access");
    expect(await read("instagram")).toMatchObject({ access_token: "new-access" });
  });

  it("propagates HTTP failures and keeps the saved authorization", async () => {
    await seed("instagram", -60_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: { code: 190 } }, 400)),
    );
    await expect(getInstagramAccessToken()).rejects.toMatchObject({
      code: "instagram_token_failed",
      status: 400,
    });
    expect(await read("instagram")).toMatchObject({ access_token: "old-access" });
  });
});

it("exchanges and stores a Mixcloud token without a refresh flow", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ access_token: "mixcloud-access" })),
  );
  await exchangeCodeForMixcloudToken("code", "https://example.com/callback");
  expect(await getMixcloudAccessToken()).toBe("mixcloud-access");
});

it.each(["fetch", "body"])(
  "aborts a stalled %s after 15 seconds without clearing authorization",
  async (phase) => {
    await seed("tiktok", -60_000);
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        signal = init?.signal;
        if (phase === "fetch") {
          return new Promise<Response>(() => {});
        }
        return { json: () => new Promise(() => {}), ok: true } as unknown as Response;
      },
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);
    const pending = getTikTokAccessToken();
    const rejected = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await rejected).toMatchObject({ message: "OAuth request timed out" });
    expect(signal?.aborted).toBe(true);
    expect(await read("tiktok")).toMatchObject({ access_token: "old-access" });
  },
);

it("keeps direct token request failures as ApiError at the Promise boundary", async () => {
  const fetchImpl = vi.fn(async () =>
    json({ error: "invalid_grant" }, 400),
  ) as unknown as typeof fetch;
  await expect(
    requestTikTokToken({ grant_type: "authorization_code" }, fetchImpl),
  ).rejects.toBeInstanceOf(ApiError);
});
