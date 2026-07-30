#!/usr/bin/env bun
//
// Apply the SECOND database's migrations — `./drizzle-telemetry` against
// `fluncle-telemetry`, the run ledger. The primary's `db:migrate` is untouched and the
// two never share a folder or a config, so a telemetry migration cannot reach the
// primary (pinned by `telemetry-isolation.test.ts`).
//
// ── THIS STEP IS NON-FATAL, AND THAT IS THE WHOLE POINT ────────────────────────
// It exits 0 on EVERY outcome, including a genuine migration failure, and it runs LAST
// in `deploy:cf` — after `wrangler deploy` and after the edge purge. Both properties are
// deliberate, and each closes a different way for a diagnostics store to break the
// product path it exists to observe:
//
//   - EXIT 0 ALWAYS: `deploy:cf` is an `&&` chain, so a non-zero exit here would abort
//     everything after it. Placed anywhere before `wrangler deploy`, a telemetry outage
//     at build time would have blocked EVERY site deploy — including a hotfix. The
//     design forbids telemetry breaking a product path, and the deploy is the most
//     consequential product path there is.
//   - LAST IN THE CHAIN: exit code aside, drizzle-kit CONNECTS. A telemetry database
//     that hangs rather than fails would stall the build for as long as the driver waits.
//     Running after the deploy means even a hang costs nothing the Worker cares about —
//     the new version is already live and the cache already purged.
//
// THE COST OF RUNNING LAST, stated so nobody rediscovers it: for one build-tail the new
// Worker is live against a not-yet-migrated ledger, so `record_run` fails for those
// seconds and those rows are lost. That is a handful of ledger rows, it is self-healing
// (the next tick writes), and absence is the ledger's own alarm. Trading a bounded row
// loss for "telemetry can never block a deploy" is the right way round.
//
// ── BUT IT IS NEVER SILENT ─────────────────────────────────────────────────────
// A quiet skip would be the exact failure this ledger was built to end — a number
// printed and read by nobody — so every run prints ONE stable, greppable verdict line:
//
//   TELEMETRY MIGRATE: ok      — provisioned, drizzle-kit applied the folder
//   TELEMETRY MIGRATE: skipped — unprovisioned; expected in local dev/tests/previews
//   TELEMETRY MIGRATE: failed  — provisioned and drizzle-kit FAILED; the ledger is behind
//
// `failed` also prints a banner naming what breaks next, because it is not self-evident:
// with the table missing or a column behind, every `record_run` POST 500s, the box
// swallows it (best-effort by design), and the ledger reads EMPTY rather than broken.
// The durable second channel for that is Sentry — a failing insert reaches
// `orpc.apiFault` (lib/server/orpc/_shared.ts) and is captured with a stack — so a
// genuinely failed migration surfaces even if nobody greps this line.

import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** The three outcomes, and the vocabulary of the verdict line. */
export type TelemetryMigrationVerdict = "failed" | "ok" | "skipped";

export type TelemetryMigrationOutcome = {
  /** Everything an operator needs after the verdict word — never a secret VALUE. */
  detail: string;
  verdict: TelemetryMigrationVerdict;
};

/** The prefix an operator (or a log grep) keys on. One line per run, always present. */
export const VERDICT_PREFIX = "TELEMETRY MIGRATE:";

/**
 * Decide the outcome. PURE in its inputs — the credential presence pair and a `migrate`
 * thunk — so a test can drive all three branches without a database and without
 * spawning drizzle-kit.
 *
 * Presence only, never the value: `${VAR:+SET}` is the repo rule for anything
 * secret-adjacent, and this prints its findings into a build log.
 */
export function telemetryMigration(deps: {
  env: Record<string, string | undefined>;
  migrate: () => { status: null | number };
}): TelemetryMigrationOutcome {
  const hasUrl = Boolean(deps.env.TURSO_TELEMETRY_DATABASE_URL?.trim());
  const hasToken = Boolean(deps.env.TURSO_TELEMETRY_AUTH_TOKEN?.trim());

  if (!hasUrl || !hasToken) {
    return {
      detail: `credentials absent (TURSO_TELEMETRY_DATABASE_URL=${hasUrl ? "SET" : "UNSET"} TURSO_TELEMETRY_AUTH_TOKEN=${hasToken ? "SET" : "UNSET"}) — run_events was NOT migrated and record_run will no-op until both are set. Expected in local dev, tests, and previews; NOT in the production build.`,
      verdict: "skipped",
    };
  }

  // A `null` status means the child never ran at all (spawn error) — indistinguishable
  // from a failure as far as the ledger is concerned, and treated as one.
  const status = deps.migrate().status;

  if (status !== 0) {
    return {
      detail: `drizzle-kit migrate exited ${status ?? "without a status"} — the run ledger is BEHIND its schema. The deploy is unaffected and already live; every record_run POST will 500 (and reach Sentry as orpc.apiFault) until this is fixed, so the ledger will read EMPTY rather than broken. Re-run: bun run --cwd apps/web db:migrate:telemetry`,
      verdict: "failed",
    };
  }

  return { detail: "drizzle-telemetry applied to fluncle-telemetry.", verdict: "ok" };
}

/** The one stable line, plus the banner a failure earns. */
export function reportTelemetryMigration(
  outcome: TelemetryMigrationOutcome,
  log: Pick<Console, "error" | "warn"> = console,
): void {
  const line = `${VERDICT_PREFIX} ${outcome.verdict} — ${outcome.detail}`;

  if (outcome.verdict === "failed") {
    log.error("=".repeat(78));
    log.error(line);
    log.error("=".repeat(78));

    return;
  }

  log.warn(line);
}

if (import.meta.main) {
  const outcome = telemetryMigration({
    env: process.env,
    migrate: () =>
      spawnSync("bunx", ["drizzle-kit", "migrate", "--config", "drizzle-telemetry.config.ts"], {
        cwd: webDir,
        stdio: "inherit",
      }),
  });

  reportTelemetryMigration(outcome);

  // ALWAYS 0. See the header: a diagnostics store must never be able to abort the chain
  // that deploys the product it observes. The verdict line above, and Sentry on the
  // first failing POST, are the channels that make a failure loud instead.
  process.exit(0);
}
