import { createClient } from "@libsql/client";
import { LOCAL_DB_CONCURRENCY } from "../database-concurrency";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createIntegrationDb } from "./integration-db";

// THE HARNESS'S OWN PIN. `createIntegrationDb` no longer replays the 131-migration chain per test;
// it replays the END-STATE DDL that chain produced, captured once per worker process (~107 ms →
// ~4 ms, and it was paid 968 times). That is only sound while the shortcut lands the SAME schema
// the migrations do — so this test builds a database BOTH ways and requires them to agree.
//
// It is the guard that lets every other integration test keep trusting "byte-identical to
// production": if a future migration produces something the capture drops (an object SQLite reports
// differently, an ordering the replay cannot satisfy), the two schemas diverge and this fails —
// rather than 968 tests quietly running against a subtly different shape.

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

type SchemaRow = { name: string; sql: null | string; type: string };

/** Every object SQLite reports, as a stable sorted fingerprint. */
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
    // The harness also builds the FTS5 index (a derived artifact, not a migration), so compare only
    // the objects the migration chain itself is responsible for.
    const actual = (await fingerprint(await createIntegrationDb())).filter((entry) =>
      expected.some((candidate) => candidate.split(" :: ")[0] === entry.split(" :: ")[0]),
    );

    expect(actual).toEqual(expected);
    // A guard on the guard: an empty comparison would pass vacuously.
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
