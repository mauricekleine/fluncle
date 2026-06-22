import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const configDir = dirname(fileURLToPath(import.meta.url));

config({ path: join(configDir, ".dev.vars") });

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required (set it in apps/web/.dev.vars)`);
  }

  return value;
}

export default defineConfig({
  dbCredentials: {
    authToken: requireEnv("TURSO_AUTH_TOKEN"),
    url: requireEnv("TURSO_DATABASE_URL"),
  },
  dialect: "turso",
  out: "./drizzle",
  schema: "./src/db/schema.ts",
});
