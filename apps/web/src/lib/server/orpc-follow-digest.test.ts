import { type Client } from "@libsql/client";
import { afterEach, beforeEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createIntegrationDb, seedUser } from "./integration-db";
import {
  AGENT_TOKEN,
  OPERATOR_TOKEN,
  req,
  setAdminTokenEnv,
  warmOrpcRouter,
} from "./orpc-test-kit";

let db: Client;

const requirePublicUser = vi.fn();

vi.mock("./public-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./public-auth")>();
  return { ...actual, requirePublicUser: (...a: unknown[]) => requirePublicUser(...a) };
});

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: () => Promise.resolve(db) };
});

beforeAll(setAdminTokenEnv);
warmOrpcRouter();

beforeEach(async () => {
  process.env.BETTER_AUTH_SECRET = "unit-test-secret";
  requirePublicUser.mockReset();
  requirePublicUser.mockResolvedValue(
    Response.json(
      { code: "auth_required", message: "Sign in to use this private account route", ok: false },
      { status: 401 },
    ),
  );
  db = await createIntegrationDb();
});

afterEach(() => db.close());

describe("follow digest contract", () => {
  it("routes the signed-in account action to revoke old manage links", async () => {
    const { createCsrfToken } = await import("./public-auth");
    const { createFollowDigestToken, verifyFollowDigestToken } =
      await import("./follow-digest-tokens");
    const { handleOrpc } = await import("./orpc");
    await seedUser(db, { email: "one@example.com", id: "one" });
    const user = { createdAt: "2026-01-01T00:00:00.000Z", id: "one", username: "one" };
    requirePublicUser.mockResolvedValue(user);
    const oldManage = await createFollowDigestToken("one", "manage");
    const response = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/me/follow-link-access/revoke", {
        body: "{}",
        headers: {
          "Content-Type": "application/json",
          origin: "https://www.fluncle.com",
          "x-fluncle-csrf": createCsrfToken(user),
        },
        method: "POST",
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { ok: boolean; token: string };
    expect(body.ok).toBe(true);
    expect(await verifyFollowDigestToken(oldManage, "manage")).toBeNull();
    expect(await verifyFollowDigestToken(body.token, "manage")).toBe("one");
  });

  it("refuses the revoke action without a session", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/me/follow-link-access/revoke", "POST", undefined, {}));
    expect(response?.status).toBe(401);
  });

  it("accepts the exact RFC 8058 form POST through the real oRPC handler", async () => {
    const { createFollowDigestToken } = await import("./follow-digest-tokens");
    const { handleOrpc } = await import("./orpc");
    await seedUser(db, { email: "one@example.com", id: "one" });
    const token = await createFollowDigestToken("one", "unsubscribe");
    const response = await handleOrpc(
      new Request(`https://www.fluncle.com/api/v1/follow-digest/unsubscribe?token=${token}`, {
        body: "List-Unsubscribe=One-Click",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true, subscribed: false });
    const state = await db.execute(
      `select unsubscribed_at from user_follow_digests where user_id = 'one'`,
    );
    expect(state.rows[0]?.unsubscribed_at).toBeTruthy();
  });

  it("refuses an unsubscribe link wherever a manage link is required", async () => {
    const { createFollowDigestToken } = await import("./follow-digest-tokens");
    const { handleOrpc } = await import("./orpc");
    await seedUser(db, { email: "one@example.com", id: "one" });
    const token = await createFollowDigestToken("one", "unsubscribe");
    const query = `token=${encodeURIComponent(token)}`;

    const subscribe = await handleOrpc(
      req(`/follow-digest/subscribe?${query}`, "POST", undefined, {}),
    );
    expect(subscribe?.status).toBe(401);
    const list = await handleOrpc(req(`/follow-digest/follows?${query}`, "GET", undefined));
    expect(list?.status).toBe(401);
    const remove = await handleOrpc(
      req(`/follow-digest/follows/follow-1?${query}`, "DELETE", undefined),
    );
    expect(remove?.status).toBe(401);
    const state = await db.execute(`select 1 from user_follow_digests where user_id = 'one'`);
    expect(state.rows).toHaveLength(0);
  });

  it("refuses an unsubscribe without a signed link", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/follow-digest/unsubscribe", "POST", undefined, {}));
    expect(response?.status).toBe(401);
  });

  it("404s removing a follow the manage link does not hold", async () => {
    const { createFollowDigestToken } = await import("./follow-digest-tokens");
    const { handleOrpc } = await import("./orpc");
    await seedUser(db, { email: "one@example.com", id: "one" });
    const token = await createFollowDigestToken("one", "manage");
    const response = await handleOrpc(
      req(`/follow-digest/follows/missing?token=${encodeURIComponent(token)}`, "DELETE", undefined),
    );
    expect(response?.status).toBe(404);
  });

  it("admits the agent to send but only the operator may change the switch", async () => {
    const { handleOrpc } = await import("./orpc");
    const send = await handleOrpc(
      req("/admin/follow-digests/send", "POST", AGENT_TOKEN, { dryRun: true }),
    );
    expect(send?.status).toBe(200);
    const forbidden = await handleOrpc(
      req("/admin/follow-digests/state", "PUT", AGENT_TOKEN, { paused: true }),
    );
    expect(forbidden?.status).toBe(403);
    const accepted = await handleOrpc(
      req("/admin/follow-digests/state", "PUT", OPERATOR_TOKEN, { paused: true }),
    );
    expect(accepted?.status).toBe(200);
  });
});
