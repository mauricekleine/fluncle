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

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: () => Promise.resolve(db) };
});

beforeAll(setAdminTokenEnv);
warmOrpcRouter();

beforeEach(async () => {
  process.env.BETTER_AUTH_SECRET = "unit-test-secret";
  db = await createIntegrationDb();
});

afterEach(() => db.close());

describe("follow digest contract", () => {
  it("routes the signed-in account action to revoke old manage links", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(req("/me/follow-link-access/revoke", "POST", undefined, {}));
    expect(response).toBeDefined();
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
