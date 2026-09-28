import { type Client, createClient as createNodeClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOCAL_DB_CONCURRENCY } from "../database-concurrency";
import { QUALIFIED_ARTISTS_SQL } from "./catalogue";
import { getDb } from "./db";
import { runWithDatabaseRequestScope } from "./database-request-scope";
import { createIntegrationDb, seedCatalogueTrack } from "./integration-db";
import {
  PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY,
  type PublicProjectionReadClient,
  readQualifiedArtistIds,
} from "./public-projection-cutover";
import { ensurePublicProjectionState } from "./public-projection-source-maintenance";

const OLD = "2026-01-01T00:00:00.000Z";

vi.mock("@libsql/client/web", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@libsql/client/web")>();
  return {
    ...actual,
    createClient: (config: { url: string }) =>
      createNodeClient({ concurrency: LOCAL_DB_CONCURRENCY, url: config.url }),
  };
});

let db: Client;
let fixtureDirectory: string | undefined;
const savedEnv = {
  authToken: process.env.TURSO_AUTH_TOKEN,
  url: process.env.TURSO_DATABASE_URL,
};

function restoreEnv(key: "TURSO_AUTH_TOKEN" | "TURSO_DATABASE_URL", value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "fluncle-qualified-fallback-"));
  const url = `file:${join(fixtureDirectory, "fixture.db")}`;
  db = await createIntegrationDb({ url });
  process.env.TURSO_DATABASE_URL = url;
  process.env.TURSO_AUTH_TOKEN = "local";

  await db.execute({
    args: [OLD, OLD],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
      values ('lane', 'Lane', 'lane', 'enabled', ?, ?)`,
  });
  await db.execute({
    args: [OLD, OLD],
    sql: `insert into artists (id, name, slug, created_at, updated_at)
      values ('weighted', 'Weighted', 'weighted', ?, ?)`,
  });
  for (const trackId of ["mb_one", "mb_two", "mb_three"]) {
    await seedCatalogueTrack(db, { trackId });
    await db.execute({
      args: [trackId],
      sql: `update tracks set label_id = 'lane' where track_id = ?`,
    });
    await db.execute({
      args: [trackId],
      sql: `insert into track_artists (track_id, artist_id, position) values (?, 'weighted', 0)`,
    });
  }
  await ensurePublicProjectionState(db);
  await db.execute({
    args: [PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY],
    sql: `insert into settings (key, value) values (?, 'true')`,
  });
  await db.execute(`insert into projection_repairs
    (projection, subject_type, subject_id, source_epoch, source_version, created_at, updated_at)
    values ('artist_qualification', 'artist', 'weighted', 0, 'pending', '${OLD}', '${OLD}')`);
});

afterEach(async () => {
  db.close();
  restoreEnv("TURSO_DATABASE_URL", savedEnv.url);
  restoreEnv("TURSO_AUTH_TOKEN", savedEnv.authToken);
  if (fixtureDirectory) {
    await rm(fixtureDirectory, { force: true, recursive: true });
    fixtureDirectory = undefined;
  }
});

describe("the legacy qualified-artist fallback", () => {
  it("sees an out-of-band label ruling in the next request even though the source epoch held", async () => {
    const readInRequest = () =>
      runWithDatabaseRequestScope(async () =>
        readQualifiedArtistIds(await getDb(), QUALIFIED_ARTISTS_SQL),
      );

    expect(await readInRequest()).toEqual(["weighted"]);

    await db.execute(`update labels set seed_state = 'disabled' where id = 'lane'`);
    const epoch = await db.execute(
      `select source_epoch from artist_qualification_state where scope = 'artists'`,
    );
    expect(Number(epoch.rows[0]?.source_epoch)).toBe(0);

    expect(await readInRequest()).toEqual([]);
  });

  it("scans the legacy union once per request however many readers share it", async () => {
    const legacyScans = await runWithDatabaseRequestScope(async () => {
      const client = await getDb();
      let scans = 0;
      const traced: PublicProjectionReadClient = {
        execute: async (statement) => {
          const sql = typeof statement === "string" ? statement : statement.sql;
          scans += sql.includes("select artist_id from (") ? 1 : 0;
          return client.execute(statement);
        },
      };
      await readQualifiedArtistIds(traced, QUALIFIED_ARTISTS_SQL);
      await readQualifiedArtistIds(traced, QUALIFIED_ARTISTS_SQL);
      await readQualifiedArtistIds(client, QUALIFIED_ARTISTS_SQL);
      return scans;
    });
    expect(legacyScans).toBe(1);
  });
});
