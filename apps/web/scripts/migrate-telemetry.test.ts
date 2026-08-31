import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  parseTelemetryMigrationRequired,
  reportTelemetryMigration,
  telemetryMigration,
  telemetryMigrationExitCode,
  VERDICT_PREFIX,
} from "./migrate-telemetry";

const PROVISIONED = {
  TURSO_TELEMETRY_AUTH_TOKEN: "token",
  TURSO_TELEMETRY_DATABASE_URL: "libsql://example.invalid",
};

describe("telemetryMigration", () => {
  it("skips an unprovisioned optional local run without connecting", () => {
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

  it("fails an unprovisioned required production run without connecting", () => {
    const migrate = vi.fn(() => ({ status: 0 }));
    const outcome = telemetryMigration({ env: {}, migrate, required: true });

    expect(outcome.verdict).toBe("failed");
    expect(outcome.detail).toMatch(/Worker deploy is blocked before publication/);
    expect(telemetryMigrationExitCode(outcome)).toBe(1);
    expect(migrate).not.toHaveBeenCalled();
  });

  it("reports credential presence only, never a value", () => {
    const outcome = telemetryMigration({
      env: { TURSO_TELEMETRY_DATABASE_URL: "libsql://super-secret-host.invalid" },
      migrate: () => ({ status: 0 }),
    });

    expect(outcome.detail).toContain("TURSO_TELEMETRY_DATABASE_URL=SET");
    expect(outcome.detail).toContain("TURSO_TELEMETRY_AUTH_TOKEN=UNSET");
    expect(outcome.detail).not.toContain("super-secret-host");
  });

  it("returns ok only when drizzle-kit succeeds", () => {
    const outcome = telemetryMigration({ env: PROVISIONED, migrate: () => ({ status: 0 }) });

    expect(outcome.verdict).toBe("ok");
    expect(telemetryMigrationExitCode(outcome)).toBe(0);
  });

  it("propagates a child failure through the process exit contract", () => {
    for (const status of [1, null]) {
      const outcome = telemetryMigration({ env: PROVISIONED, migrate: () => ({ status }) });

      expect(outcome.verdict).toBe("failed");
      expect(outcome.detail).toMatch(/fails closed/);
      expect(outcome.detail).toMatch(/db:migrate:telemetry/);
      expect(telemetryMigrationExitCode(outcome)).toBe(1);
    }
  });

  it("accepts only the explicit production requirement flag", () => {
    expect(parseTelemetryMigrationRequired([])).toBe(false);
    expect(parseTelemetryMigrationRequired(["--required"])).toBe(true);
    expect(() => parseTelemetryMigrationRequired(["--optional"])).toThrow(/only supported/);
    expect(() => parseTelemetryMigrationRequired(["--required", "extra"])).toThrow(
      /only supported/,
    );
  });
});

describe("reportTelemetryMigration", () => {
  it("emits one identically prefixed verdict line for every outcome", () => {
    const lines: string[] = [];
    const log = {
      error: (message: string) => lines.push(message),
      warn: (message: string) => lines.push(message),
    };

    for (const verdict of ["failed", "ok", "skipped"] as const) {
      reportTelemetryMigration({ detail: "why", verdict }, log);
    }

    expect(lines.filter((line) => line.startsWith(`${VERDICT_PREFIX} `))).toHaveLength(3);
    expect(lines).toContain(`${VERDICT_PREFIX} failed — why`);
  });

  it("puts failures on stderr inside a banner", () => {
    const error = vi.fn();
    const warn = vi.fn();

    reportTelemetryMigration({ detail: "why", verdict: "failed" }, { error, warn });

    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(3);
  });
});

describe("deploy:cf telemetry ordering", () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as { scripts: Record<string, string> };
  const chain = pkg.scripts["deploy:cf"] ?? "";

  it("requires telemetry migration after the primary migration and before Worker publication", () => {
    const primaryAt = chain.indexOf("bun run db:migrate:production");
    const telemetryAt = chain.indexOf("bun run db:migrate:telemetry:production");
    const deployAt = chain.indexOf("wrangler deploy");

    expect(primaryAt).toBe(0);
    expect(telemetryAt).toBeGreaterThan(primaryAt);
    expect(deployAt).toBeGreaterThan(telemetryAt);
    expect(chain).not.toContain("bun run db:backfill");
  });

  it("pins the production wrapper to required mode", () => {
    expect(pkg.scripts["db:migrate:telemetry:production"]).toBe(
      "bun run scripts/migrate-telemetry.ts --required",
    );
  });
});
