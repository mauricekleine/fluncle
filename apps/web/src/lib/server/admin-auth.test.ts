import { beforeAll, describe, expect, it } from "vitest";
import { isAllowedSpotifyUser, signGrant, verifyGrant } from "./admin-auth";
import {
  ADMIN_COOKIE_NAME,
  ADMIN_GRANT_MAX_AGE_MS,
  requireAdmin,
  signState,
  verifyState,
} from "./env";

const TOKEN = "test-token-admin-auth";

function adminRequest(headers: Record<string, string>): Request {
  return new Request("https://fluncle.com/api/admin/tracks/abc", { headers, method: "PATCH" });
}

// Pin a deterministic signing key. readEnv reads process.env at call time (not
// import time), and loadLocalEnv's dotenv never overrides an already-set value,
// so this wins over .dev.vars and keeps the suite independent of local secrets.
beforeAll(() => {
  process.env.FLUNCLE_API_TOKEN = TOKEN;
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("admin grant (the browser carrier)", () => {
  it("round-trips a freshly signed grant", async () => {
    expect(await verifyGrant(await signGrant())).toBe(true);
  });

  it("rejects a tampered signature", async () => {
    const grant = await signGrant();
    const tampered = `${grant.slice(0, -1)}${grant.at(-1) === "a" ? "b" : "a"}`;

    expect(await verifyGrant(tampered)).toBe(false);
  });

  it("rejects a missing or malformed grant", async () => {
    expect(await verifyGrant(undefined)).toBe(false);
    expect(await verifyGrant(null)).toBe(false);
    expect(await verifyGrant("")).toBe(false);
    expect(await verifyGrant("not-a-grant")).toBe(false);
  });

  it("rejects an expired grant (older than the session window)", async () => {
    const expired = await signState({
      iat: Date.now() - (ADMIN_GRANT_MAX_AGE_MS + DAY_MS),
      role: "admin",
    });

    expect(await verifyGrant(expired)).toBe(false);
  });

  it("rejects a validly signed payload that is not an admin grant", async () => {
    // A real OAuth state is signed with the same key but carries no admin role.
    const oauthState = await signState({ iat: Date.now(), purpose: "spotify-auth" });

    expect(await verifyGrant(oauthState)).toBe(false);
  });
});

describe("verifyState keeps its tight OAuth window after the refactor", () => {
  it("accepts a state inside 10 minutes", async () => {
    const fresh = await signState({ iat: Date.now() - 9 * 60 * 1000, purpose: "spotify-auth" });

    await expect(verifyState(fresh)).resolves.toMatchObject({ purpose: "spotify-auth" });
  });

  it("rejects a state older than 10 minutes (the admin window would have kept it)", async () => {
    const stale = await signState({ iat: Date.now() - 11 * 60 * 1000, purpose: "spotify-auth" });

    await expect(verifyState(stale)).rejects.toThrow();
  });
});

describe("requireAdmin accepts either carrier (one identity, two carriers)", () => {
  it("accepts the CLI's Bearer token", async () => {
    expect(await requireAdmin(adminRequest({ Authorization: `Bearer ${TOKEN}` }))).toBeUndefined();
  });

  it("accepts the browser's signed grant cookie", async () => {
    const grant = await signGrant();

    expect(
      await requireAdmin(adminRequest({ cookie: `${ADMIN_COOKIE_NAME}=${grant}` })),
    ).toBeUndefined();
  });

  it("401s a request with neither carrier", async () => {
    const response = await requireAdmin(adminRequest({}));

    expect(response?.status).toBe(401);
  });

  it("401s a wrong Bearer token and a tampered cookie", async () => {
    const grant = await signGrant();
    const tampered = `${grant.slice(0, -1)}${grant.at(-1) === "a" ? "b" : "a"}`;

    expect((await requireAdmin(adminRequest({ Authorization: "Bearer nope" })))?.status).toBe(401);
    expect(
      (await requireAdmin(adminRequest({ cookie: `${ADMIN_COOKIE_NAME}=${tampered}` })))?.status,
    ).toBe(401);
  });
});

describe("isAllowedSpotifyUser (the one-operator allow-list)", () => {
  it("allows the operator by email, case-insensitively", () => {
    expect(isAllowedSpotifyUser({ email: "kleine.m.r@gmail.com", id: "anything" })).toBe(true);
    expect(isAllowedSpotifyUser({ email: "Kleine.M.R@Gmail.com", id: "anything" })).toBe(true);
  });

  it("allows the operator by Spotify id even without an email", () => {
    expect(isAllowedSpotifyUser({ id: "berry_fudge" })).toBe(true);
  });

  it("rejects anyone else", () => {
    expect(isAllowedSpotifyUser({ email: "someone@else.com", id: "rando" })).toBe(false);
    expect(isAllowedSpotifyUser({ id: "rando" })).toBe(false);
  });
});
