import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationDb, seedUser } from "./integration-db";
import {
  createFollowDigestToken,
  revokeFollowDigestManageLinks,
  verifyFollowDigestToken,
} from "./follow-digest-tokens";

const originalSecret = process.env.BETTER_AUTH_SECRET;
let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: () => Promise.resolve(db) };
});

beforeEach(async () => {
  process.env.BETTER_AUTH_SECRET = "unit-test-secret";
  db = await createIntegrationDb();
  await seedUser(db, { email: "one@example.com", id: "user.one" });
});

afterEach(() => {
  db.close();
  if (originalSecret === undefined) {
    delete process.env.BETTER_AUTH_SECRET;
  } else {
    process.env.BETTER_AUTH_SECRET = originalSecret;
  }
});

describe("follow digest signed links", () => {
  it("accepts only the intended user and purpose", async () => {
    const token = await createFollowDigestToken("user.one", "manage");
    expect(await verifyFollowDigestToken(token, "manage")).toBe("user.one");
    expect(await verifyFollowDigestToken(token, "unsubscribe")).toBeNull();
    expect(
      await verifyFollowDigestToken(
        `${Buffer.from("other").toString("base64url")}.${token.split(".").slice(1).join(".")}`,
        "manage",
      ),
    ).toBeNull();
    expect(await verifyFollowDigestToken(`${token.slice(0, -1)}x`, "manage")).toBeNull();
  });

  it("expires manage links after 30 days but keeps unsubscribe links valid", async () => {
    const issuedAt = new Date("2026-01-01T00:00:00.000Z");
    const manage = await createFollowDigestToken("user.one", "manage", issuedAt);
    const unsubscribe = await createFollowDigestToken("user.one", "unsubscribe", issuedAt);
    expect(await verifyFollowDigestToken(manage, "manage", new Date("2026-01-30T23:59:59Z"))).toBe(
      "user.one",
    );
    expect(
      await verifyFollowDigestToken(manage, "manage", new Date("2026-01-31T00:00:00Z")),
    ).toBeNull();
    expect(
      await verifyFollowDigestToken(unsubscribe, "unsubscribe", new Date("2027-01-01T00:00:00Z")),
    ).toBe("user.one");
  });

  it("rejects old unversioned manage links and revokes only manage links", async () => {
    const oldKey = createHmac("sha256", "unit-test-secret").update("follow-digest:v1").digest();
    const oldSignature = createHmac("sha256", oldKey)
      .update("follow-digest:manage:user.one")
      .digest("base64url");
    const legacy = `${Buffer.from("user.one").toString("base64url")}.manage.${oldSignature}`;
    expect(await verifyFollowDigestToken(legacy, "manage")).toBeNull();
    const oldManage = await createFollowDigestToken("user.one", "manage");
    const unsubscribe = await createFollowDigestToken("user.one", "unsubscribe");
    await revokeFollowDigestManageLinks("user.one");
    expect(await verifyFollowDigestToken(oldManage, "manage")).toBeNull();
    expect(await verifyFollowDigestToken(unsubscribe, "unsubscribe")).toBe("user.one");
    expect(
      await verifyFollowDigestToken(await createFollowDigestToken("user.one", "manage"), "manage"),
    ).toBe("user.one");
  });

  it("invalidates links after account deletion", async () => {
    const manage = await createFollowDigestToken("user.one", "manage");
    const unsubscribe = await createFollowDigestToken("user.one", "unsubscribe");
    await db.execute({
      args: ["user.one"],
      sql: `update "user" set status = 'deleted' where id = ?`,
    });
    expect(await verifyFollowDigestToken(manage, "manage")).toBeNull();
    expect(await verifyFollowDigestToken(unsubscribe, "unsubscribe")).toBeNull();
  });
});
import { createHmac } from "node:crypto";
