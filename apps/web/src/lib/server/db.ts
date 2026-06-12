import { createClient, type Row } from "@libsql/client/web";
import { readEnvs } from "./env";

export async function getDb() {
  const env = await readEnvs(["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);

  return createClient({
    authToken: env.TURSO_AUTH_TOKEN,
    url: env.TURSO_DATABASE_URL,
  });
}

export function typedRow<T extends object>(rows: Row[]): T | undefined {
  return rows[0] as T | undefined;
}

export function typedRows<T extends object>(rows: Row[]): T[] {
  return rows as T[];
}
