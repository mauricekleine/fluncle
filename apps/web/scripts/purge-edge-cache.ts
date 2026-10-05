#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import {
  APP_HOSTS,
  edgeCacheUrl,
  purgeCredentialsFromEnv,
  purgeEdgeCacheHosts,
  purgeEdgeCacheUrls,
} from "./lib/edge-cache-purge";

const argv = process.argv.slice(2);
const fileIndex = argv.indexOf("--urls-file");
const filePath = fileIndex >= 0 ? argv[fileIndex + 1] : undefined;
const targets = [
  ...(fileIndex >= 0 ? argv.slice(0, fileIndex).concat(argv.slice(fileIndex + 2)) : argv),
  ...(filePath ? readFileSync(filePath, "utf8").split("\n") : []),
]
  .map((line) => line.trim())
  .filter((line) => line !== "");
const urls = targets.map((target) => (target.startsWith("/") ? edgeCacheUrl(target) : target));

const credentials = purgeCredentialsFromEnv();

if (!credentials) {
  console.error(
    "cache:purge: set CF_CACHE_PURGE_TOKEN (op read op://$FLUNCLE_1PASSWORD_ENV_ITEM/CF_CACHE_PURGE_TOKEN).",
  );
  process.exit(1);
}

if (urls.length === 0) {
  await purgeEdgeCacheHosts(credentials);
  console.log(`cache:purge: purged by hostname (${APP_HOSTS.join(", ")}).`);
} else {
  const count = await purgeEdgeCacheUrls(urls, credentials);
  console.log(`cache:purge: purged ${count} URL(s).`);
}
