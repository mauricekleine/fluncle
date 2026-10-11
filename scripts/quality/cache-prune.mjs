#!/usr/bin/env node
import { execFileSync } from "node:child_process";

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

try {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must identify the cache owner");
  }
  for (const [prefix, key] of [
    ["turbo-v2-", process.env.TURBO_CACHE_KEY],
    ["cargo-quality-v2-", process.env.CARGO_CACHE_KEY],
    ["playwright-", process.env.PLAYWRIGHT_CACHE_KEY],
  ]) {
    if (!key) {
      continue;
    }
    if (!key.startsWith(prefix)) {
      throw new Error(`Unexpected key for ${prefix}`);
    }
    const endpoint = `repos/${repository}/actions/caches`;
    const pages = JSON.parse(
      gh(
        "api",
        "--paginate",
        "--slurp",
        `${endpoint}?ref=refs%2Fheads%2Fmain&key=${encodeURIComponent(prefix)}&per_page=100&sort=created_at&direction=desc`,
      ),
    );
    const caches = pages
      .flatMap((page) => page.actions_caches)
      .filter((cache) => cache.ref === "refs/heads/main" && cache.key.startsWith(prefix))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
    if (!caches.some((cache) => cache.key === key)) {
      process.stdout.write(`${prefix}: current snapshot absent; retaining prior caches\n`);
      continue;
    }
    const [keep, ...stale] = caches;
    process.stdout.write(`${prefix}: keep ${keep.id} (${keep.key}); delete ${stale.length}\n`);
    for (const cache of stale) {
      gh("api", "--method", "DELETE", `${endpoint}/${cache.id}`);
    }
  }
} catch (error) {
  process.stderr.write(`cache prune: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
