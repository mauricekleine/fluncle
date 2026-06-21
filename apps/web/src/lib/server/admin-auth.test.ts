import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { isAllowedSpotifyUser, signGrant, verifyGrant } from "./admin-auth";
import {
  ADMIN_COOKIE_NAME,
  ADMIN_GRANT_MAX_AGE_MS,
  adminRole,
  requireAdmin,
  requireOperator,
  signState,
  verifyState,
} from "./env";

const TOKEN = "test-token-admin-auth";
const AGENT_TOKEN = "test-token-agent-auth";
const SESSION_SECRET = "test-session-secret-admin-auth";

function adminRequest(headers: Record<string, string>): Request {
  return new Request("https://fluncle.com/api/admin/tracks/abc", { headers, method: "PATCH" });
}

// Pin deterministic secrets. readEnv reads process.env at call time (not import
// time), and loadLocalEnv's dotenv never overrides an already-set value, so
// these win over .dev.vars and keep the suite independent of local secrets. The
// Bearer carrier (FLUNCLE_API_TOKEN) and the cookie/state signing key
// (ADMIN_SESSION_SECRET) are DELIBERATELY different values here — they are
// separate secrets in production too.
beforeAll(() => {
  process.env.FLUNCLE_API_TOKEN = TOKEN;
  process.env.FLUNCLE_AGENT_TOKEN = AGENT_TOKEN;
  process.env.ADMIN_SESSION_SECRET = SESSION_SECRET;
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

// Two roles, one umbrella. requireAdmin accepts any admin principal (operator OR
// agent); requireOperator accepts only the operator and 403s a valid agent token.
// This is what moves the publish boundary off the box gate and into the Worker:
// the agent token simply lacks the authority, server-side.
describe("admin roles (operator vs agent)", () => {
  const bearer = (token: string) => adminRequest({ Authorization: `Bearer ${token}` });

  it("maps each carrier to its role", async () => {
    expect(await adminRole(bearer(TOKEN))).toBe("operator");
    expect(await adminRole(bearer(AGENT_TOKEN))).toBe("agent");
    expect(
      await adminRole(adminRequest({ cookie: `${ADMIN_COOKIE_NAME}=${await signGrant()}` })),
    ).toBe("operator");
    expect(await adminRole(adminRequest({}))).toBeNull();
    expect(await adminRole(bearer("nope"))).toBeNull();
  });

  it("requireAdmin accepts both the operator and the agent token", async () => {
    expect(await requireAdmin(bearer(TOKEN))).toBeUndefined();
    expect(await requireAdmin(bearer(AGENT_TOKEN))).toBeUndefined();
  });

  it("requireOperator accepts the operator (token + cookie), 403s the agent, 401s a stranger", async () => {
    expect(await requireOperator(bearer(TOKEN))).toBeUndefined();
    expect(
      await requireOperator(adminRequest({ cookie: `${ADMIN_COOKIE_NAME}=${await signGrant()}` })),
    ).toBeUndefined();

    expect((await requireOperator(bearer(AGENT_TOKEN)))?.status).toBe(403);
    expect((await requireOperator(adminRequest({})))?.status).toBe(401);
    expect((await requireOperator(bearer("nope")))?.status).toBe(401);
  });

  it("a forged agent token (wrong value) is no principal at all", async () => {
    expect(await adminRole(bearer(`${AGENT_TOKEN}x`))).toBeNull();
    expect((await requireOperator(bearer(`${AGENT_TOKEN}x`)))?.status).toBe(401);
  });
});

// The whole point of the secret split: a session/state signed with the API
// Bearer token (FLUNCLE_API_TOKEN) must NOT verify — only ADMIN_SESSION_SECRET
// does. So a leaked Bearer token can never forge a {role:"admin"} cookie.
describe("admin-session signing key is split from the API Bearer token", () => {
  // Hand-forge a "<base64url body>.<base64url HMAC>" state signed with `key`,
  // mirroring signState's wire format so we can sign with an arbitrary secret.
  function forgeState(payload: Record<string, string | number>, key: string): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", key).update(body).digest("base64url");

    return `${body}.${signature}`;
  }

  it("rejects a grant cookie forged with the API token (the old signing key)", async () => {
    const forged = forgeState({ iat: Date.now(), role: "admin" }, TOKEN);

    // The cookie carrier rejects it...
    expect(await verifyGrant(forged)).toBe(false);
    // ...and so does the route gate that consumes the same cookie.
    expect(
      (await requireAdmin(adminRequest({ cookie: `${ADMIN_COOKIE_NAME}=${forged}` })))?.status,
    ).toBe(401);
  });

  it("rejects an OAuth state forged with the API token", async () => {
    const forged = forgeState({ iat: Date.now(), purpose: "spotify-auth" }, TOKEN);

    await expect(verifyState(forged)).rejects.toThrow();
  });

  it("accepts a grant/state signed with ADMIN_SESSION_SECRET", async () => {
    // signState uses ADMIN_SESSION_SECRET; an equivalent hand-forge with the same
    // secret must verify — proving the split moved the key, not broke signing.
    const grant = await signGrant();
    expect(await verifyGrant(grant)).toBe(true);

    const forgedWithSecret = forgeState({ iat: Date.now(), role: "admin" }, SESSION_SECRET);
    expect(await verifyGrant(forgedWithSecret)).toBe(true);
    expect(
      await requireAdmin(adminRequest({ cookie: `${ADMIN_COOKIE_NAME}=${forgedWithSecret}` })),
    ).toBeUndefined();
  });
});

describe("isAllowedSpotifyUser (the operator allow-list, from env)", () => {
  // Synthetic values — the real operator identity lives only in the deployed
  // env, never in the repo. dotenv won't override these already-set vars.
  beforeAll(() => {
    process.env.ADMIN_ALLOWED_EMAILS = "operator@example.com";
    process.env.ADMIN_ALLOWED_SPOTIFY_IDS = "test_operator";
  });

  it("allows the operator by email, case-insensitively", async () => {
    expect(await isAllowedSpotifyUser({ email: "operator@example.com", id: "x" })).toBe(true);
    expect(await isAllowedSpotifyUser({ email: "Operator@Example.com", id: "x" })).toBe(true);
  });

  it("allows the operator by Spotify id even without an email", async () => {
    expect(await isAllowedSpotifyUser({ id: "test_operator" })).toBe(true);
  });

  it("rejects anyone else", async () => {
    expect(await isAllowedSpotifyUser({ email: "someone@else.com", id: "rando" })).toBe(false);
    expect(await isAllowedSpotifyUser({ id: "rando" })).toBe(false);
  });
});
