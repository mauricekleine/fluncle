import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { loadEnv } from "../env";
import * as schema from "./schema";

const env = loadEnv(["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);

const client = createClient({
  url: env.TURSO_DATABASE_URL,
  authToken: env.TURSO_AUTH_TOKEN,
});

export const db = drizzle({ client, schema });
