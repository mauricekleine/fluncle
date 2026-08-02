import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isAllowedSpotifyUser, signGrant, verifyGrant } from "./admin-auth";
import {
  ADMIN_COOKIE_NAME,
  ADMIN_GRANT_EPOCH_KEY,
  ADMIN_GRANT_MAX_AGE_MS,
  adminRole,
  requireAdmin,
  requireOperator,
  revokeAdminGrants,
  signOauthState,
  verifyState,
} from "./env";

const TOKEN = "test-token-admin-auth";
const AGENT_TOKEN = "test-token-agent-auth";
const SESSION_SECRET = "test-session-secret-admin-auth";

// The grant epoch lives in the `settings` KV, which env.ts reads through a lazy
// `import("./settings")`. Stub that KV in-memory: the epoch is a COLLABORATOR of the
// auth logic under test, and stubbing it lets the suite drive the three states that
// matter — unset (a fresh deploy), bumped (a revocation), and unreadable (a DB blip,
// which must FAIL CLOSED).
let epochValue: string | undefined;
let epochReadThrows = false;

vi.mock("./settings", () => ({
  deleteSetting: async () => {
    epochValue = undefined;
  },
  getSetting: async (key: string) => {
    if (epochReadThrows) {
      throw new Error("settings unreachable");
    }

    return key === ADMIN_GRANT_EPOCH_KEY ? epochValue : undefined;
  },
  setSetting: async (key: string, value: string) => {
    if (key === ADMIN_GRANT_EPOCH_KEY) {
      epochValue = value;
    }
  },
}));

function adminRequest(headers: Record<string, string>): Request {
  return new Request("https://fluncle.com/api/admin/tracks/abc", { headers, method: "PATCH" });
}

// A cookie-carried admin request that satisfies the mutation origin guard, so these
// suites keep testing the CARRIER (cookie vs Bearer) rather than the origin check —
// which has its own suite in ./admin-mutation-origin.test.ts.
function cookieRequest(grant: string): Request {
  return adminRequest({
    cookie: `${ADMIN_COOKIE_NAME}=${grant}`,
    origin: "https://fluncle.com",
  });
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
  // Freeze the clock so every `Date.now()` — the `iat` a state is signed with AND
  // the `now` it is verified against — reads the same instant. The grant/OAuth
  // window math (fresh vs stale, expired) becomes exact instead of relying on the
  // two reads landing in the same tick.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-22T12:00:00.000Z"));
});

beforeEach(() => {
  epochValue = undefined;
  epochReadThrows = false;
});

afterAll(() => {
  vi.useRealTimers();
});

const DAY_MS = 24 * 60 * 60 * 1000;

// The two labeled subkeys env.ts derives from ADMIN_SESSION_SECRET. Reproduced here
// (rather than imported) so the test pins the DERIVATION, not just the code path: if
// the labels or the derivation change, these hand-forges stop verifying.
function subkey(label: string): Buffer {
  return createHmac("sha256", SESSION_SECRET).update(label).digest();
}

const GRANT_KEY = subkey("fluncle/admin-grant-cookie/v1");
const OAUTH_KEY = subkey("fluncle/oauth-state/v1");

/** Hand-forge a `<base64url body>.<base64url HMAC>` credential under an arbitrary key. */
function forge(payload: Record<string, string | number>, key: Buffer | string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", key).update(body).digest("base64url");

  return `${body}.${signature}`;
}

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
    const expired = forge(
      { epoch: 0, iat: Date.now() - (ADMIN_GRANT_MAX_AGE_MS + DAY_MS), role: "admin" },
      GRANT_KEY,
    );

    expect(await verifyGrant(expired)).toBe(false);
  });

  it("rejects a validly signed payload that is not an admin grant", async () => {
    const notAGrant = forge({ epoch: 0, iat: Date.now(), purpose: "spotify-auth" }, GRANT_KEY);

    expect(await verifyGrant(notAGrant)).toBe(false);
  });

  it("keeps the 30-day window (revocation is the brake, not a shorter session)", async () => {
    const nearlyStale = forge(
      { epoch: 0, iat: Date.now() - (ADMIN_GRANT_MAX_AGE_MS - DAY_MS), role: "admin" },
      GRANT_KEY,
    );

    expect(await verifyGrant(nearlyStale)).toBe(true);
  });
});

// The key separation: ADMIN_SESSION_SECRET signs nothing directly, so a credential
// minted for one purpose can never be replayed as the other — even though the two
// share a root secret and a wire format.
describe("grant cookie and OAuth state ride SEPARATE derived subkeys", () => {
  it("refuses a grant payload signed with the OAUTH subkey", async () => {
    const crossSigned = forge({ epoch: 0, iat: Date.now(), role: "admin" }, OAUTH_KEY);

    expect(await verifyGrant(crossSigned)).toBe(false);
    expect((await requireAdmin(cookieRequest(crossSigned)))?.status).toBe(401);
  });

  it("refuses an OAuth state signed with the GRANT subkey", async () => {
    const crossSigned = forge({ iat: Date.now(), purpose: "spotify-auth" }, GRANT_KEY);

    await expect(verifyState(crossSigned)).rejects.toThrow();
  });

  it("refuses either credential signed with the RAW root secret (keys are derived)", async () => {
    const rawGrant = forge({ epoch: 0, iat: Date.now(), role: "admin" }, SESSION_SECRET);
    const rawState = forge({ iat: Date.now(), purpose: "spotify-auth" }, SESSION_SECRET);

    expect(await verifyGrant(rawGrant)).toBe(false);
    await expect(verifyState(rawState)).rejects.toThrow();
  });

  it("still round-trips each credential under its OWN subkey", async () => {
    expect(await verifyGrant(forge({ epoch: 0, iat: Date.now(), role: "admin" }, GRANT_KEY))).toBe(
      true,
    );
    await expect(
      verifyState(forge({ iat: Date.now(), purpose: "spotify-auth" }, OAUTH_KEY)),
    ).resolves.toMatchObject({ purpose: "spotify-auth" });
  });
});

// The revocation handle for an otherwise unrevocable stateless cookie.
describe("grant epoch (revocation)", () => {
  it("accepts a grant when the epoch key is UNSET (fresh deploy, epoch 0)", async () => {
    const grant = await signGrant();

    expect(epochValue).toBeUndefined();
    expect(await verifyGrant(grant)).toBe(true);
  });

  it("kills every outstanding grant on a bump, and mints working ones after", async () => {
    const before = await signGrant();
    expect(await verifyGrant(before)).toBe(true);

    expect(await revokeAdminGrants()).toBe(1);

    // The pre-bump cookie is dead...
    expect(await verifyGrant(before)).toBe(false);
    expect((await requireAdmin(cookieRequest(before)))?.status).toBe(401);

    // ...and a fresh login works immediately.
    const after = await signGrant();
    expect(await verifyGrant(after)).toBe(true);
    expect(await requireAdmin(cookieRequest(after))).toBeUndefined();
  });

  it("bumps monotonically, so a second revoke also invalidates the first re-login", async () => {
    await revokeAdminGrants();
    const secondEra = await signGrant();

    expect(await revokeAdminGrants()).toBe(2);
    expect(await verifyGrant(secondEra)).toBe(false);
  });

  it("does NOT touch the Bearer carriers (the CLI/box are not epoch-scoped)", async () => {
    await revokeAdminGrants();

    expect(await requireAdmin(adminRequest({ Authorization: `Bearer ${TOKEN}` }))).toBeUndefined();
    expect(
      await requireAdmin(adminRequest({ Authorization: `Bearer ${AGENT_TOKEN}` })),
    ).toBeUndefined();
    expect(
      await requireOperator(adminRequest({ Authorization: `Bearer ${TOKEN}` })),
    ).toBeUndefined();
  });

  it("rejects a grant carrying NO epoch at all (pre-epoch cookie)", async () => {
    const unEpoched = forge({ iat: Date.now(), role: "admin" }, GRANT_KEY);

    expect(await verifyGrant(unEpoched)).toBe(false);
  });

  it("rejects a grant whose epoch is not an integer", async () => {
    expect(
      await verifyGrant(forge({ epoch: 1.5, iat: Date.now(), role: "admin" }, GRANT_KEY)),
    ).toBe(false);
  });

  it("FAILS CLOSED when the epoch cannot be read (a revocation must never fail open)", async () => {
    const grant = await signGrant();
    expect(await verifyGrant(grant)).toBe(true);

    epochReadThrows = true;

    expect(await verifyGrant(grant)).toBe(false);
    expect((await requireAdmin(cookieRequest(grant)))?.status).toBe(401);

    // The Bearer carrier is unaffected, which is what keeps the CLI recovery path open.
    expect(await requireAdmin(adminRequest({ Authorization: `Bearer ${TOKEN}` }))).toBeUndefined();
  });

  it("FAILS CLOSED on a malformed stored epoch, and a revoke REPAIRS it", async () => {
    const grant = await signGrant();

    for (const malformed of ["not-a-number", "", "   ", "-1", "1.5"]) {
      epochValue = malformed;
      expect(await verifyGrant(grant), malformed).toBe(false);
    }

    epochValue = "not-a-number";

    // The repair jumps to a whole-seconds timestamp (the previous epoch is unknown,
    // so incrementing would be unsafe), then normal minting works again.
    const repaired = await revokeAdminGrants();
    expect(repaired).toBe(Math.floor(Date.now() / 1000));
    expect(await verifyGrant(await signGrant())).toBe(true);
  });
});

describe("verifyState keeps its tight OAuth window after the refactor", () => {
  it("accepts a state inside 10 minutes", async () => {
    const fresh = await signOauthState({
      iat: Date.now() - 9 * 60 * 1000,
      purpose: "spotify-auth",
    });

    await expect(verifyState(fresh)).resolves.toMatchObject({ purpose: "spotify-auth" });
  });

  it("rejects a state older than 10 minutes (the admin window would have kept it)", async () => {
    const stale = await signOauthState({
      iat: Date.now() - 11 * 60 * 1000,
      purpose: "spotify-auth",
    });

    await expect(verifyState(stale)).rejects.toThrow();
  });
});

describe("requireAdmin accepts either carrier (one identity, two carriers)", () => {
  it("accepts the CLI's Bearer token", async () => {
    expect(await requireAdmin(adminRequest({ Authorization: `Bearer ${TOKEN}` }))).toBeUndefined();
  });

  it("accepts the browser's signed grant cookie", async () => {
    expect(await requireAdmin(cookieRequest(await signGrant()))).toBeUndefined();
  });

  it("401s a request with neither carrier", async () => {
    const response = await requireAdmin(adminRequest({}));

    expect(response?.status).toBe(401);
  });

  it("401s a wrong Bearer token and a tampered cookie", async () => {
    const grant = await signGrant();
    const tampered = `${grant.slice(0, -1)}${grant.at(-1) === "a" ? "b" : "a"}`;

    expect((await requireAdmin(adminRequest({ Authorization: "Bearer nope" })))?.status).toBe(401);
    expect((await requireAdmin(cookieRequest(tampered)))?.status).toBe(401);
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
    expect(await adminRole(cookieRequest(await signGrant()))).toBe("operator");
    expect(await adminRole(adminRequest({}))).toBeNull();
    expect(await adminRole(bearer("nope"))).toBeNull();
  });

  it("requireAdmin accepts both the operator and the agent token", async () => {
    expect(await requireAdmin(bearer(TOKEN))).toBeUndefined();
    expect(await requireAdmin(bearer(AGENT_TOKEN))).toBeUndefined();
  });

  it("requireOperator accepts the operator (token + cookie), 403s the agent, 401s a stranger", async () => {
    expect(await requireOperator(bearer(TOKEN))).toBeUndefined();
    expect(await requireOperator(cookieRequest(await signGrant()))).toBeUndefined();

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
  it("rejects a grant cookie forged with the API token", async () => {
    const forged = forge({ epoch: 0, iat: Date.now(), role: "admin" }, TOKEN);

    // The cookie carrier rejects it...
    expect(await verifyGrant(forged)).toBe(false);
    // ...and so does the route gate that consumes the same cookie.
    expect((await requireAdmin(cookieRequest(forged)))?.status).toBe(401);
  });

  it("rejects an OAuth state forged with the API token", async () => {
    const forged = forge({ iat: Date.now(), purpose: "spotify-auth" }, TOKEN);

    await expect(verifyState(forged)).rejects.toThrow();
  });

  it("accepts a grant signed with the grant subkey derived from ADMIN_SESSION_SECRET", async () => {
    const grant = await signGrant();
    expect(await verifyGrant(grant)).toBe(true);

    const forgedWithSubkey = forge({ epoch: 0, iat: Date.now(), role: "admin" }, GRANT_KEY);
    expect(await verifyGrant(forgedWithSubkey)).toBe(true);
    expect(await requireAdmin(cookieRequest(forgedWithSubkey))).toBeUndefined();
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
