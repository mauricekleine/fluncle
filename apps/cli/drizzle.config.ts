import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const configDir = dirname(fileURLToPath(import.meta.url));

config({ path: join(configDir, "../web/.dev.vars") });

export default defineConfig({
  dbCredentials: {
    authToken: process.env.TURSO_AUTH_TOKEN!,
    url: process.env.TURSO_DATABASE_URL!,
  },
  dialect: "turso",
  out: "./drizzle",
  schema: "./src/db/schema.ts",
});
