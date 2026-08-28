#!/usr/bin/env bun
/**
 * Apply the SECOND database's migrations: `./drizzle-telemetry` against the run ledger.
 *
 * The primary and telemetry folders/configs remain disjoint. A manual/local run may skip an
 * unprovisioned telemetry database. The production deploy calls this script with `--required`
 * before `wrangler deploy`; missing credentials or a failed migration then exits non-zero, so a
 * Worker that writes the additive schema can never race that schema into production.
 */
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = dirname(dirname(fileURLToPath(import.meta.url)));

export type TelemetryMigrationVerdict = "failed" | "ok" | "skipped";

export type TelemetryMigrationOutcome = {
  /** Everything an operator needs after the verdict word — never a secret value. */
  detail: string;
  verdict: TelemetryMigrationVerdict;
};

export const VERDICT_PREFIX = "TELEMETRY MIGRATE:";

export function parseTelemetryMigrationRequired(args: readonly string[]): boolean {
  if (args.length === 0) {
    return false;
  }
  if (args.length === 1 && args[0] === "--required") {
    return true;
  }

  throw new Error("telemetry migration: the only supported argument is --required");
}

/** Decide the outcome without connecting unless the credential pair is complete. */
export function telemetryMigration(deps: {
  env: Record<string, string | undefined>;
  migrate: () => { status: null | number };
  required?: boolean;
}): TelemetryMigrationOutcome {
  const hasUrl = Boolean(deps.env.TURSO_TELEMETRY_DATABASE_URL?.trim());
  const hasToken = Boolean(deps.env.TURSO_TELEMETRY_AUTH_TOKEN?.trim());

  if (!hasUrl || !hasToken) {
    const presence = `TURSO_TELEMETRY_DATABASE_URL=${hasUrl ? "SET" : "UNSET"} TURSO_TELEMETRY_AUTH_TOKEN=${hasToken ? "SET" : "UNSET"}`;

    if (deps.required) {
      return {
        detail: `credentials absent (${presence}) — the required production telemetry schema was NOT migrated, so the Worker deploy is blocked before publication.`,
        verdict: "failed",
      };
    }

    return {
      detail: `credentials absent (${presence}) — run_events was NOT migrated. Expected only in local dev, tests, and previews.`,
      verdict: "skipped",
    };
  }

  const status = deps.migrate().status;
  if (status !== 0) {
    return {
      detail: `drizzle-kit migrate exited ${status ?? "without a status"} — the run ledger is BEHIND its schema. The command fails closed; re-run: bun run --cwd apps/web db:migrate:telemetry`,
      verdict: "failed",
    };
  }

  return { detail: "drizzle-telemetry applied to the run ledger.", verdict: "ok" };
}

/** The one stable line, with a banner around the failure branch. */
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

export function telemetryMigrationExitCode(outcome: TelemetryMigrationOutcome): 0 | 1 {
  return outcome.verdict === "failed" ? 1 : 0;
}

if (import.meta.main) {
  try {
    const required = parseTelemetryMigrationRequired(process.argv.slice(2));
    const outcome = telemetryMigration({
      env: process.env,
      migrate: () =>
        spawnSync("bunx", ["drizzle-kit", "migrate", "--config", "drizzle-telemetry.config.ts"], {
          cwd: webDir,
          stdio: "inherit",
        }),
      required,
    });

    reportTelemetryMigration(outcome);
    process.exitCode = telemetryMigrationExitCode(outcome);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "telemetry migration failed");
    process.exitCode = 1;
  }
}
