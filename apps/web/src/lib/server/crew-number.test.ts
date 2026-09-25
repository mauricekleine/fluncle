import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillCrewNumbers } from "../../../scripts/backfill-crew-numbers";
import { createIntegrationDb, seedUser } from "./integration-db";
import { assignCrewNumber } from "./public-auth";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
});

afterEach(() => {
  db.close();
});

async function crewNumberOf(id: string): Promise<number | null> {
  const result = await db.execute({
    args: [id],
    sql: `select crew_number from "user" where id = ?`,
  });
  const value = result.rows[0]?.crew_number;

  return value == null ? null : Number(value);
}

describe("assignCrewNumber", () => {
  it("stamps 1 on the first account and increments from the running max", async () => {
    await seedUser(db, { email: "a@example.com", id: "user-a" });
    await seedUser(db, { email: "b@example.com", id: "user-b" });

    expect(await assignCrewNumber("user-a", db)).toBe(1);
    expect(await assignCrewNumber("user-b", db)).toBe(2);
  });

  it("is idempotent — a second call never re-stamps or bumps the number", async () => {
    await seedUser(db, { email: "a@example.com", id: "user-a" });

    expect(await assignCrewNumber("user-a", db)).toBe(1);

    expect(await assignCrewNumber("user-a", db)).toBeUndefined();
    expect(await crewNumberOf("user-a")).toBe(1);
  });

  it("never collides under two rapid concurrent sign-ups", async () => {
    await seedUser(db, { email: "a@example.com", id: "user-a" });
    await seedUser(db, { email: "b@example.com", id: "user-b" });

    const [first, second] = await Promise.all([
      assignCrewNumber("user-a", db),
      assignCrewNumber("user-b", db),
    ]);

    expect([first, second].sort((a, b) => Number(a) - Number(b))).toEqual([1, 2]);

    const counts = await db.execute({
      sql: `select count(distinct crew_number) as distinct_n, count(crew_number) as total_n from "user"`,
    });
    expect(Number(counts.rows[0]?.distinct_n)).toBe(2);
    expect(Number(counts.rows[0]?.total_n)).toBe(2);
  });
});

describe("backfillCrewNumbers", () => {
  it("numbers existing accounts oldest-first and is idempotent across re-runs", async () => {
    await seedUser(db, { createdAt: 3000, email: "c@example.com", id: "user-c" });
    await seedUser(db, { createdAt: 1000, email: "a@example.com", id: "user-a" });
    await seedUser(db, { createdAt: 2000, email: "b@example.com", id: "user-b" });

    const first = await backfillCrewNumbers(db);
    expect(first).toEqual({ assigned: 3, skipped: 0 });

    expect(await crewNumberOf("user-a")).toBe(1);
    expect(await crewNumberOf("user-b")).toBe(2);
    expect(await crewNumberOf("user-c")).toBe(3);

    const second = await backfillCrewNumbers(db);
    expect(second).toEqual({ assigned: 0, skipped: 3 });
    expect(await crewNumberOf("user-a")).toBe(1);
    expect(await crewNumberOf("user-c")).toBe(3);
  });

  it("numbers only the stragglers when a new account appears after a first pass", async () => {
    await seedUser(db, { createdAt: 1000, email: "a@example.com", id: "user-a" });
    await backfillCrewNumbers(db);

    await seedUser(db, { createdAt: 5000, email: "d@example.com", id: "user-d" });

    const result = await backfillCrewNumbers(db);
    expect(result).toEqual({ assigned: 1, skipped: 1 });
    expect(await crewNumberOf("user-a")).toBe(1);
    expect(await crewNumberOf("user-d")).toBe(2);
  });
});
