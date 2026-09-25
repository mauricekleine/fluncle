import { type Client, createClient } from "@libsql/client";
import { LOCAL_DB_CONCURRENCY } from "../database-concurrency";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle-telemetry", import.meta.url));

export async function createTelemetryIntegrationDb(): Promise<Client> {
  const client = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });

  await migrate(drizzle(client), { migrationsFolder });

  return client;
}
