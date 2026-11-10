import { type Client, type InStatement } from "@libsql/client";
import { beforeEach, expect, it, vi } from "vitest";
import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";

let db: Client;
const executed: InStatement[] = [];

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getDb: () =>
      Promise.resolve({
        execute: (statement: InStatement) => {
          executed.push(statement);
          return db.execute(statement);
        },
      }),
  };
});

const { getMixTracksByTokens } = await import("./tracks");

beforeEach(async () => {
  db = await createIntegrationDb();
  executed.length = 0;
  await seedTrack(db, { logId: "001.0.1A", trackId: "found-1" });
  await seedTrack(db, { logId: "001.0.1B", trackId: "found-2" });
  await seedCatalogueTrack(db, { trackId: "cat-1" });
  await seedCatalogueTrack(db, { trackId: "cat-2" });
});

async function planOf(statement: InStatement): Promise<string[]> {
  const { args, sql } = typeof statement === "string" ? { args: [], sql: statement } : statement;
  const result = await db.execute({ args: args ?? [], sql: `explain query plan ${sql}` });
  return result.rows.map((row) => String(row.detail));
}

it("resolves a set mixing log ids and track ids by key, never by walking tracks", async () => {
  const items = await getMixTracksByTokens(["001.0.1A", "cat-1", "found-2"]);

  expect(items.map((item) => item.trackId).toSorted()).toEqual(["cat-1", "found-1", "found-2"]);
  const statement = executed.at(-1);
  if (statement === undefined) {
    throw new Error("getMixTracksByTokens issued no statement");
  }
  const plan = await planOf(statement);
  expect(plan.some((detail) => detail.startsWith("SCAN tracks"))).toBe(false);
  expect(plan.some((detail) => detail.includes("findings_log_id_unique"))).toBe(true);
});

it("resolves a set of only log ids through the findings log id index", async () => {
  const items = await getMixTracksByTokens(["001.0.1B"]);

  expect(items.map((item) => item.trackId)).toEqual(["found-2"]);
  const statement = executed.at(-1);
  if (statement === undefined) {
    throw new Error("getMixTracksByTokens issued no statement");
  }
  const plan = await planOf(statement);
  expect(plan.some((detail) => detail.startsWith("SCAN tracks"))).toBe(false);
});
