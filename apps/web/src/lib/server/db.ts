import { createClient } from "@libsql/client/web";
import { readEnvs } from "./env";

export async function getDb() {
  const env = await readEnvs(["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);

  return createClient({
    authToken: env.TURSO_AUTH_TOKEN,
    url: env.TURSO_DATABASE_URL,
  });
}
