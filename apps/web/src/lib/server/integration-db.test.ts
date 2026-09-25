import { createClient } from "@libsql/client";
import { LOCAL_DB_CONCURRENCY } from "../database-concurrency";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createIntegrationDb } from "./integration-db";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

type SchemaRow = { name: string; sql: null | string; type: string };

async function fingerprint(client: {
  execute: (sql: string) => Promise<{ rows: unknown[] }>;
}): Promise<string[]> {
  const result = await client.execute(
    `select type, name, sql from sqlite_master order by type, name`,
  );

  return (result.rows as unknown as SchemaRow[])
    .map((row) => `${row.type} ${row.name} :: ${(row.sql ?? "").replace(/\s+/g, " ").trim()}`)
    .sort();
}

describe("createIntegrationDb replays the migrations' end state", () => {
  it("produces a schema identical to running the full migration chain", async () => {
    const viaMigrations = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

    await migrate(drizzle(viaMigrations), { migrationsFolder });

    const expected = await fingerprint(viaMigrations);

    const actual = (await fingerprint(await createIntegrationDb())).filter((entry) =>
      expected.some((candidate) => candidate.split(" :: ")[0] === entry.split(" :: ")[0]),
    );

    expect(actual).toEqual(expected);

    expect(expected.length).toBeGreaterThan(100);
  });

  it("hands out ISOLATED databases — a write to one is invisible to the next", async () => {
    const first = await createIntegrationDb();
    const second = await createIntegrationDb();

    await first.execute(
      `insert into tracks (track_id, title, artists_json, duration_ms)
       values ('iso00000000000000000a', 'Isolation', '["A"]', 270000)`,
    );

    const seen = await second.execute("select count(*) as n from tracks");

    expect(Number((seen.rows[0] as unknown as { n: number }).n)).toBe(0);
  });
});
