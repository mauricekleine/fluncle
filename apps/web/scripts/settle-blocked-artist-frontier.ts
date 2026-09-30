#!/usr/bin/env bun

import { settleGloballyBlockedFrontier } from "../src/lib/server/crawl";
import { getDb } from "../src/lib/server/db";
import { loadLocalEnv } from "../src/lib/server/env";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 2 || (args.length > 0 && args[0] !== "--limit")) {
    throw new Error("usage: bun run scripts/settle-blocked-artist-frontier.ts [--limit 1..500]");
  }
  const limit = args.length === 0 ? 100 : Number(args[1]);
  await loadLocalEnv({ force: true });
  const db = await getDb();
  try {
    const settled = await settleGloballyBlockedFrontier(db, limit);
    console.log(`settled ${settled} globally blocked frontier nodes; run again until zero`);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  await main();
}
