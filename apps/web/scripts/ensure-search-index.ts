#!/usr/bin/env bun
/**
 * Build (or repair) the FTS5 search index over `tracks` — the second half of `db:migrate`.
 *
 * The DDL and the reasoning live in `src/db/search-index.ts`; this is only the runner that
 * hands it a client. Wiring it into `db:migrate` (rather than `db:backfill`) is deliberate:
 * `db:migrate` is what EVERY environment runs — the Cloudflare deploy (`deploy:cf`), a
 * local dev boot (`scripts/dev.ts`), and a worktree refresh — so the index exists wherever
 * the schema does. The integration harness (`src/lib/server/integration-db.ts`) calls the
 * same `ensureSearchIndex` straight after applying the migrations.
 *
 * Idempotent: on a steady-state database it is three `if not exists` no-ops and one count.
 *
 * Credentials, like every sibling script: the Cloudflare deploy environment provides
 * `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`; locally they come from `.dev.vars`.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSearchIndex } from "../src/db/search-index";

async function main(): Promise<void> {
  if (!process.env.TURSO_DATABASE_URL) {
    config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars") });
  }

  const url = process.env.TURSO_DATABASE_URL;

  if (!url) {
    throw new Error("TURSO_DATABASE_URL is required (set it in apps/web/.dev.vars)");
  }

  const authToken = process.env.TURSO_AUTH_TOKEN;
  const client = createClient(authToken ? { authToken, url } : { url });
  const result = await ensureSearchIndex(client);

  console.log(
    `search index: ${result.indexed} tracks indexed${result.rebuilt ? " (rebuilt)" : " (already current)"}.`,
  );
}

if (import.meta.main) {
  await main();
}
