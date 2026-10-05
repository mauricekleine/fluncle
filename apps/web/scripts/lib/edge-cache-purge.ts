import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CANONICAL_ORIGIN = "https://www.fluncle.com";

export const APP_HOSTS = ["www.fluncle.com", "galaxy.fluncle.com", "radio.fluncle.com"];

const URLS_PER_REQUEST = 30;

export type PurgeCredentials = { token: string; zoneId: string };

export function readZoneId(): string {
  const configPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "cloudflare.config.ts",
  );
  const match = readFileSync(configPath, "utf8").match(
    /CF_CACHE_PURGE_ZONE_ID:\s*bindings\.text\("([0-9a-f]{32})"\)/,
  );

  if (!match?.[1]) {
    throw new Error("CF_CACHE_PURGE_ZONE_ID not found in apps/web/cloudflare.config.ts");
  }

  return match[1];
}

export function purgeCredentialsFromEnv(
  env: Record<string, string | undefined> = process.env,
): PurgeCredentials | undefined {
  const token = env.CF_CACHE_PURGE_TOKEN?.trim();

  return token ? { token, zoneId: env.CF_CACHE_PURGE_ZONE_ID?.trim() || readZoneId() } : undefined;
}

export function edgeCacheUrl(path: string): string {
  return `${CANONICAL_ORIGIN}${path}`;
}

async function purge(
  credentials: PurgeCredentials,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/zones/${credentials.zoneId}/purge_cache`,
    {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${credentials.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(`purge failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  }
}

export async function purgeEdgeCacheUrls(
  urls: readonly string[],
  credentials: PurgeCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const unique = [...new Set(urls)];

  for (let i = 0; i < unique.length; i += URLS_PER_REQUEST) {
    await purge(credentials, { files: unique.slice(i, i + URLS_PER_REQUEST) }, fetchImpl);
  }

  return unique.length;
}

export async function purgeEdgeCacheHosts(
  credentials: PurgeCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await purge(credentials, { hosts: APP_HOSTS }, fetchImpl);
}
