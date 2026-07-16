import { type Client } from "@libsql/client";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";
import { createIntegrationDb } from "./integration-db";
import { createPublicAuthOptions } from "./public-auth";

// End-to-end proof that the `user.create.after` sign-up hook fires and does its two
// jobs (the account-redesign brief): stamp the crew number (ruling #1) and auto-
// subscribe the email to the newsletter (ruling #5) — best-effort, never failing the
// sign-up. We build a REAL better-auth instance over an in-memory libSQL DB with the
// real migrations, and drive `auth.api.signUpEmail` so the actual create path runs.
//
// The Google/social path uses this SAME hook (it lands via the OAuth `/callback/:id`
// create path — verified against the better-auth 1.6.x docs), so proving it on the
// email path proves it for both; a real OAuth round-trip cannot be driven in a unit
// test without a live Google.

// The one shared DB for the file: the real `getPublicAuth` memo (reached by the
// subscribe path's `getPublicSession`) binds to it once, so every test shares one
// live client and there is no stale-client teardown between tests.
let db: Client;

// Spy on the only outbound the subscribe path makes, so nothing hits the network.
const addContactToSegment = vi.fn<(email: string) => Promise<void>>();

vi.mock("./resend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./resend")>();

  return {
    ...actual,
    addContactToSegment: (email: string) => addContactToSegment(email),
    sendPasswordResetEmail: vi.fn(async () => {}),
    sendVerificationEmail: vi.fn(async () => {}),
  };
});

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return {
    ...actual,
    getDb: () => Promise.resolve(db),
    getDrizzleDb: () => Promise.resolve(drizzle(db, { schema })),
  };
});

function buildAuth() {
  return betterAuth(createPublicAuthOptions(drizzle(db, { schema })));
}

async function crewNumberOfEmail(email: string): Promise<number | null> {
  const result = await db.execute({
    args: [email],
    sql: `select crew_number from "user" where email = ?`,
  });
  const value = result.rows[0]?.crew_number;

  return value == null ? null : Number(value);
}

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET = "test-crew-number-secret-please-change";
  // The subscribe path reaches the real `getPublicAuth`, which needs a base URL; set
  // one so it builds a valid instance (unset, it poisons `process.env` to "undefined").
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  db = await createIntegrationDb();
});

afterEach(() => {
  addContactToSegment.mockReset();
});

afterAll(() => {
  db.close();
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.BETTER_AUTH_URL;
});

describe("sign-up hooks", () => {
  it("stamps a crew number and auto-subscribes on email/password sign-up", async () => {
    const auth = buildAuth();

    await auth.api.signUpEmail({
      body: { email: "newjunglist@example.com", name: "New Junglist", password: "amenbreak99" },
    });

    // Ruling #1: the account is on the manifest.
    expect(await crewNumberOfEmail("newjunglist@example.com")).toBeGreaterThanOrEqual(1);
    // Ruling #5: its email went to the newsletter segment.
    expect(addContactToSegment).toHaveBeenCalledWith("newjunglist@example.com");
  });

  it("never fails the sign-up when the newsletter subscribe faults", async () => {
    // Resend is down for this one call — the subscribe throws deep in the hook.
    addContactToSegment.mockRejectedValueOnce(new Error("resend exploded"));

    const auth = buildAuth();

    // The sign-up still resolves — the fault is swallowed and logged, never rethrown.
    await expect(
      auth.api.signUpEmail({
        body: { email: "resilient@example.com", name: "Resilient", password: "amenbreak99" },
      }),
    ).resolves.toBeDefined();

    // And the crew number was still stamped: the two side effects are independent.
    expect(await crewNumberOfEmail("resilient@example.com")).toBeGreaterThanOrEqual(1);
  });
});
