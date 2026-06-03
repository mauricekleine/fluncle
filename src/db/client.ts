import { createClient } from "@libsql/client/web";
import { loadEnv } from "../env";

const env = loadEnv(["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);

export const db = createClient({
  url: env.TURSO_DATABASE_URL,
  authToken: env.TURSO_AUTH_TOKEN,
});
