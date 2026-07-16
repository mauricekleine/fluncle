import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillCrewNumbers } from "../../../scripts/backfill-crew-numbers";
import { createIntegrationDb, seedUser } from "./integration-db";
import { assignCrewNumber } from "./public-auth";

// REAL-SQL tests for the crew-number ordinal (the account-redesign brief, ruling #1):
// the atomic `max + 1` assignment, its idempotence + concurrency safety, and the
// one-time backfill. Everything runs against an in-memory libSQL DB with the real
// generated migrations applied (so the UNIQUE index is the production one), driving
// `assignCrewNumber` / `backfillCrewNumbers` with an EXPLICIT client — no `getDb()`
// mock needed.

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
    // Already numbered ⇒ `WHERE crew_number IS NULL` updates 0 rows ⇒ undefined, and
    // the stored value is untouched.
    expect(await assignCrewNumber("user-a", db)).toBeUndefined();
    expect(await crewNumberOf("user-a")).toBe(1);
  });

  it("never collides under two rapid concurrent sign-ups", async () => {
    await seedUser(db, { email: "a@example.com", id: "user-a" });
    await seedUser(db, { email: "b@example.com", id: "user-b" });

    // Fire both at once against the one DB — libSQL serializes the writes, so the two
    // `MAX + 1` reads cannot both land on the same number.
    const [first, second] = await Promise.all([
      assignCrewNumber("user-a", db),
      assignCrewNumber("user-b", db),
    ]);

    expect([first, second].sort((a, b) => Number(a) - Number(b))).toEqual([1, 2]);

    // And the UNIQUE index really holds across the whole table (two distinct numbers,
    // two stamped rows — no duplicate slipped past).
    const counts = await db.execute({
      sql: `select count(distinct crew_number) as distinct_n, count(crew_number) as total_n from "user"`,
    });
    expect(Number(counts.rows[0]?.distinct_n)).toBe(2);
    expect(Number(counts.rows[0]?.total_n)).toBe(2);
  });
});

describe("backfillCrewNumbers", () => {
  it("numbers existing accounts oldest-first and is idempotent across re-runs", async () => {
    // Seeded OUT of creation order to prove the run sorts by created_at, not insert order.
    await seedUser(db, { createdAt: 3000, email: "c@example.com", id: "user-c" });
    await seedUser(db, { createdAt: 1000, email: "a@example.com", id: "user-a" });
    await seedUser(db, { createdAt: 2000, email: "b@example.com", id: "user-b" });

    const first = await backfillCrewNumbers(db);
    expect(first).toEqual({ assigned: 3, skipped: 0 });

    // Oldest created_at → №1: the founding order becomes the manifest order.
    expect(await crewNumberOf("user-a")).toBe(1);
    expect(await crewNumberOf("user-b")).toBe(2);
    expect(await crewNumberOf("user-c")).toBe(3);

    // Re-run: nothing left to number, every value stable.
    const second = await backfillCrewNumbers(db);
    expect(second).toEqual({ assigned: 0, skipped: 3 });
    expect(await crewNumberOf("user-a")).toBe(1);
    expect(await crewNumberOf("user-c")).toBe(3);
  });

  it("numbers only the stragglers when a new account appears after a first pass", async () => {
    await seedUser(db, { createdAt: 1000, email: "a@example.com", id: "user-a" });
    await backfillCrewNumbers(db);

    // A newcomer that somehow has no number yet (e.g. the hook was skipped once).
    await seedUser(db, { createdAt: 5000, email: "d@example.com", id: "user-d" });

    const result = await backfillCrewNumbers(db);
    expect(result).toEqual({ assigned: 1, skipped: 1 });
    expect(await crewNumberOf("user-a")).toBe(1);
    expect(await crewNumberOf("user-d")).toBe(2);
  });
});
