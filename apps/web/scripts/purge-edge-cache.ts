// Purge the zone's edge cache as the LAST step of a production deploy (deploy:cf).
//
// Why: every deploy replaces the hashed /assets/* files, but edge-cached HTML keeps
// referencing the OLD hashes until its TTL runs out (fresh + stale-while-revalidate,
// see lib/server/edge-cache.ts). In that window a cached page loads a 404 stylesheet
// and renders unstyled — observed live on 2026-07-26 after a rapid deploy train. The
// purge closes the window: new HTML and new assets go live together.
//
// Credentials: the zone id is the committed public identifier in wrangler.jsonc (it
// grants nothing alone); the token must come from the Cloudflare BUILD environment as
// CF_CACHE_PURGE_TOKEN — a Worker runtime secret is NOT visible to the build shell, so
// the operator adds it to the build env once. Absent token = a loud no-op, never a
// failed deploy: a missing purge only re-opens the pre-existing TTL window.
//
// Scope: hostname-scoped purge for the app host first (keeps found.fluncle.com's
// derived media warm); if the zone plan rejects hostname purge, fall back to
// purge_everything — a briefly cold media cache beats an unstyled site.

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

// A failed purge must not fail the deploy — the artifact is already live; the only
// cost of skipping is the same TTL window that existed before this script.
console.error(
  `purge-edge-cache: purge failed (${everything.status}) ${(await everything.text()).slice(0, 200)} — continuing; the TTL window applies.`,
);
process.exit(0);
