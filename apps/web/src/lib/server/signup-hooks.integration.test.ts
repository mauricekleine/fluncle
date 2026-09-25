import { type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";
import { createIntegrationDb } from "./integration-db";
import { createIntegrationAuth } from "./integration-auth";

let db: Client;

const addContactToSegment = vi.fn<(email: string) => Promise<void>>();
const notifyDiscordSignup = vi.fn<({ crewNumber }: { crewNumber?: number }) => Promise<void>>();

vi.mock("./discord-alert", () => ({
  notifyDiscordSignup: (alert: { crewNumber?: number }) => notifyDiscordSignup(alert),
}));

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
  return createIntegrationAuth(drizzle(db, { schema }));
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
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  db = await createIntegrationDb();
});

beforeEach(() => {
  notifyDiscordSignup.mockResolvedValue(undefined);
});

afterEach(() => {
  addContactToSegment.mockReset();
  notifyDiscordSignup.mockReset();
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

    expect(await crewNumberOfEmail("newjunglist@example.com")).toBeGreaterThanOrEqual(1);
    expect(addContactToSegment).toHaveBeenCalledWith("newjunglist@example.com");
    expect(notifyDiscordSignup).toHaveBeenCalledWith({
      crewNumber: await crewNumberOfEmail("newjunglist@example.com"),
    });
  });

  it("never fails the sign-up when the newsletter subscribe faults", async () => {
    addContactToSegment.mockRejectedValueOnce(new Error("resend exploded"));

    const auth = buildAuth();

    await expect(
      auth.api.signUpEmail({
        body: { email: "resilient@example.com", name: "Resilient", password: "amenbreak99" },
      }),
    ).resolves.toBeDefined();

    expect(await crewNumberOfEmail("resilient@example.com")).toBeGreaterThanOrEqual(1);
  });

  it("never fails the sign-up when the Discord alert faults", async () => {
    notifyDiscordSignup.mockRejectedValueOnce(new Error("Discord exploded"));

    const auth = buildAuth();

    await expect(
      auth.api.signUpEmail({
        body: { email: "quiet@example.com", name: "Quiet", password: "amenbreak99" },
      }),
    ).resolves.toBeDefined();

    expect(await crewNumberOfEmail("quiet@example.com")).toBeGreaterThanOrEqual(1);
    expect(addContactToSegment).toHaveBeenCalledWith("quiet@example.com");
  });
});
