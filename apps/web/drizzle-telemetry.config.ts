// The drizzle config for the SECOND database, `fluncle-telemetry` (the run ledger).
//
// Deliberately a separate config with its own `out:` folder: the telemetry schema and
// the primary schema must NEVER share a migrations folder, so a telemetry migration
// cannot reach the primary database (and vice versa). `drizzle.config.ts` is the
// primary's; this one is telemetry's, and neither knows about the other.
//
// CREDENTIALS ARE OPTIONAL HERE ON PURPOSE. `drizzle-kit generate` never connects — it
// diffs `./src/db/telemetry-schema.ts` against `./drizzle-telemetry` — so an
// unprovisioned checkout can still generate a migration. `migrate` DOES connect, and it
// is driven by `scripts/migrate-telemetry.ts`, which refuses (loudly) to run when the
// pair is unset rather than letting drizzle-kit dial a placeholder.

import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const configDir = dirname(fileURLToPath(import.meta.url));

config({ path: join(configDir, ".dev.vars") });

export default defineConfig({
  dbCredentials: {
    authToken: process.env.TURSO_TELEMETRY_AUTH_TOKEN ?? "",
    url: process.env.TURSO_TELEMETRY_DATABASE_URL ?? "",
  },
  dialect: "turso",
  out: "./drizzle-telemetry",
  schema: "./src/db/telemetry-schema.ts",
});
