import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { reportTelemetryMigration, telemetryMigration, VERDICT_PREFIX } from "./migrate-telemetry";

// THE DEPLOY BOUNDARY. This step migrates a DIAGNOSTICS store from inside `deploy:cf`,
// an `&&` chain that ends in `wrangler deploy`. The rule it must obey is therefore not
// "migrate correctly" but "never be able to stop the site from deploying" — while still
// being impossible to mistake for a success when it failed.
//
// Both halves are pinned here because both have exactly one plausible regression: someone
// makes the failure branch `process.exit(1)` "so it's noticed", and a telemetry outage
// starts blocking hotfixes; or someone quiets the skip branch, and the ledger stays empty
// while the build reads clean — which is the class of failure this ledger was built to end.

const PROVISIONED = {
  TURSO_TELEMETRY_AUTH_TOKEN: "token",
  TURSO_TELEMETRY_DATABASE_URL: "libsql://example.invalid",
};

describe("telemetryMigration — the three outcomes are distinguishable", () => {
  it("SKIPS, without migrating, when either credential is absent", () => {
    // Local dev, the test suite, and every preview are in this state. Note what is
    // asserted: `migrate` is never called, so an unprovisioned checkout cannot even
    // attempt a connection.
    for (const env of [
      {},
      { TURSO_TELEMETRY_DATABASE_URL: "libsql://example.invalid" },
      { TURSO_TELEMETRY_AUTH_TOKEN: "token" },
      { ...PROVISIONED, TURSO_TELEMETRY_DATABASE_URL: "   " },
    ]) {
      const migrate = vi.fn(() => ({ status: 0 }));

      expect(telemetryMigration({ env, migrate }).verdict).toBe("skipped");
      expect(migrate).not.toHaveBeenCalled();
    }
  });

  it("reports credential PRESENCE only, never a value", () => {
    // This detail lands in a public-ish build log. `${VAR:+SET}` is the repo rule.
    const outcome = telemetryMigration({
      env: { TURSO_TELEMETRY_DATABASE_URL: "libsql://super-secret-host.invalid" },
      migrate: () => ({ status: 0 }),
    });

    expect(outcome.detail).toContain("TURSO_TELEMETRY_DATABASE_URL=SET");
    expect(outcome.detail).toContain("TURSO_TELEMETRY_AUTH_TOKEN=UNSET");
    expect(outcome.detail).not.toContain("super-secret-host");
  });

  it("reports `ok` when drizzle-kit applied the folder", () => {
    expect(telemetryMigration({ env: PROVISIONED, migrate: () => ({ status: 0 }) })).toMatchObject({
      verdict: "ok",
    });
  });

  it("reports `failed` — never `ok` and never `skipped` — when drizzle-kit fails", () => {
    // The distinguishability requirement: a genuine failure must not be able to read as
    // either of the benign outcomes. A missing status (the spawn never ran) counts too.
    expect(telemetryMigration({ env: PROVISIONED, migrate: () => ({ status: 1 }) })).toMatchObject({
      verdict: "failed",
    });
    expect(
      telemetryMigration({ env: PROVISIONED, migrate: () => ({ status: null }) }),
    ).toMatchObject({ verdict: "failed" });
  });

  it("says what a failure BREAKS, because it is not self-evident", () => {
    // With the table behind, every record_run POST 500s and the box swallows it, so the
    // ledger reads EMPTY rather than broken. An operator reading only "failed" would not
    // know that, and an empty ledger is indistinguishable from a quiet fleet.
    const { detail } = telemetryMigration({ env: PROVISIONED, migrate: () => ({ status: 1 }) });

    expect(detail).toMatch(/record_run/);
    expect(detail).toMatch(/Sentry/);
    expect(detail).toMatch(/db:migrate:telemetry/);
  });
});

describe("reportTelemetryMigration — one greppable line per run", () => {
  it("prefixes every verdict identically, so one grep finds all three", () => {
    const lines: string[] = [];
    const log = { error: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) };

    for (const verdict of ["failed", "ok", "skipped"] as const) {
      reportTelemetryMigration({ detail: "why", verdict }, log);
    }

    expect(lines.filter((line) => line.startsWith(`${VERDICT_PREFIX} `))).toHaveLength(3);
    expect(lines).toContain(`${VERDICT_PREFIX} ok — why`);
    expect(lines).toContain(`${VERDICT_PREFIX} skipped — why`);
    expect(lines).toContain(`${VERDICT_PREFIX} failed — why`);
  });

  it("puts a failure on stderr inside a banner, and the benign outcomes on warn", () => {
    const error = vi.fn();
    const warn = vi.fn();

    reportTelemetryMigration({ detail: "why", verdict: "failed" }, { error, warn });

    expect(warn).not.toHaveBeenCalled();
    // Banner rules above and below, so the line cannot get lost in a 15-minute build log.
    expect(error).toHaveBeenCalledTimes(3);

    error.mockClear();
    reportTelemetryMigration({ detail: "why", verdict: "ok" }, { error, warn });

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("deploy:cf — telemetry can never gate the deploy", () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as { scripts: Record<string, string> };
  const chain = pkg.scripts["deploy:cf"] ?? "";

  it("runs the telemetry migration AFTER wrangler deploy", () => {
    // The finding this pins: with the step before `wrangler deploy` in an `&&` chain, a
    // telemetry outage at build time aborted the chain before the deploy — no site deploy
    // could land, hotfixes included. Position, not just the exit code, is the guarantee:
    // drizzle-kit CONNECTS, so a telemetry database that HANGS would stall the build even
    // with a non-fatal exit.
    const deployAt = chain.indexOf("wrangler deploy");
    const telemetryAt = chain.indexOf("db:migrate:telemetry");

    expect(deployAt).toBeGreaterThanOrEqual(0);
    expect(telemetryAt).toBeGreaterThan(deployAt);
  });

  it("keeps the guarded PRIMARY migration before the deploy", () => {
    // The counterweight: the primary's schema is a product dependency of the code being
    // deployed, so the production wrapper must still inspect and migrate it first. Only the
    // diagnostics store moved.
    const primaryAt = chain.indexOf("bun run db:migrate:production");

    expect(primaryAt).toBeGreaterThanOrEqual(0);
    expect(primaryAt).toBeLessThan(chain.indexOf("wrangler deploy"));
  });
});
