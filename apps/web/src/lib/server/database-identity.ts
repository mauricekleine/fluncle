import { type Client } from "@libsql/client";

export type IdentifiableDatabaseClient = Pick<Client, "execute">;

const databaseIdentities = new WeakMap<IdentifiableDatabaseClient, string>();

export function registerDatabaseIdentity<ClientResult extends IdentifiableDatabaseClient>(
  client: ClientResult,
  identity: string,
): ClientResult {
  databaseIdentities.set(client, identity);
  return client;
}

export function databaseIdentityOf(client: IdentifiableDatabaseClient): string | undefined {
  return databaseIdentities.get(client);
}
