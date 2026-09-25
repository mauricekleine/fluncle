import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_HOSTS = ["www.fluncle.com", "galaxy.fluncle.com", "radio.fluncle.com"];

const token = process.env.CF_CACHE_PURGE_TOKEN;

if (!token) {
  console.log(
    "purge-edge-cache: CF_CACHE_PURGE_TOKEN is not in the build env — skipping the post-deploy purge (cached HTML may reference retired asset hashes until its TTL expires; add the token to the Cloudflare build environment to close the window).",
  );
  process.exit(0);
}

const wranglerPath = join(dirname(fileURLToPath(import.meta.url)), "..", "wrangler.jsonc");
const wrangler = readFileSync(wranglerPath, "utf8");
const zoneMatch = wrangler.match(/"CF_CACHE_PURGE_ZONE_ID":\s*"([0-9a-f]{32})"/);

if (!zoneMatch) {
  console.error("purge-edge-cache: CF_CACHE_PURGE_ZONE_ID not found in wrangler.jsonc — skipping.");
  process.exit(0);
}

const zoneId = zoneMatch[1];

async function purge(body: Record<string, unknown>): Promise<Response> {
  return fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method: "POST",
  });
}

const byHost = await purge({ hosts: APP_HOSTS });

if (byHost.ok) {
  console.log(`purge-edge-cache: purged by hostname (${APP_HOSTS.join(", ")}).`);
  process.exit(0);
}

const hostErr = await byHost.text();
console.log(
  `purge-edge-cache: hostname purge unavailable (${byHost.status}) — falling back to purge_everything. ${hostErr.slice(0, 200)}`,
);

const everything = await purge({ purge_everything: true });

if (everything.ok) {
  console.log("purge-edge-cache: purged everything.");
  process.exit(0);
}

console.error(
  `purge-edge-cache: purge failed (${everything.status}) ${(await everything.text()).slice(0, 200)} — continuing; the TTL window applies.`,
);
process.exit(0);
