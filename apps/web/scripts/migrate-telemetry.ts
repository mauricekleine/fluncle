#!/usr/bin/env bun
//
// Apply the SECOND database's migrations — `./drizzle-telemetry` against
// `fluncle-telemetry`, the run ledger. The primary's `db:migrate` is untouched and the
// two never share a folder, so a telemetry migration cannot reach the primary.
//
// WHY A WRAPPER instead of `drizzle-kit migrate --config …` straight in `deploy:cf`:
// the telemetry pair is read from the BUILD environment, and the deploy must not become
// hostage to it. Unprovisioned, a bare drizzle-kit call would abort the Cloudflare build
// and take the whole Worker deploy down with it — a diagnostics store breaking the
// product path it exists to observe, which is the one thing this design forbids.
//
// So it SKIPS when unprovisioned — but never silently. A skipped migration announces
// itself in the build log, because "printed and read by nobody" is the exact failure the
// run ledger was built to end, and shipping the ledger with a quiet skip of its own
// would be a poor joke. Provisioned, it runs drizzle-kit for real and a failure fails
// the build, exactly as the primary's migrate does.

import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = dirname(dirname(fileURLToPath(import.meta.url)));

// Presence only — never the value. `${VAR:+SET}`-style checks are the repo rule for
// anything secret-adjacent.
const hasUrl = Boolean(process.env.TURSO_TELEMETRY_DATABASE_URL?.trim());
const hasToken = Boolean(process.env.TURSO_TELEMETRY_AUTH_TOKEN?.trim());

if (!hasUrl || !hasToken) {
  console.warn(
    [
      "SKIPPED telemetry migrations: the fluncle-telemetry credentials are not in this environment.",
      `  TURSO_TELEMETRY_DATABASE_URL=${hasUrl ? "SET" : "UNSET"} TURSO_TELEMETRY_AUTH_TOKEN=${hasToken ? "SET" : "UNSET"}`,
      "  The run ledger (run_events) will not be migrated, and record_run will no-op until both are set.",
      "  This is expected in local dev, tests, and previews. In the production build it is NOT —",
      "  add both to the Cloudflare build environment so this step runs for real.",
    ].join("\n"),
  );

  process.exit(0);
}

const result = spawnSync(
  "bunx",
  ["drizzle-kit", "migrate", "--config", "drizzle-telemetry.config.ts"],
  { cwd: webDir, stdio: "inherit" },
);

process.exit(result.status ?? 1);
