import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  resolveScaleBenchTarget,
  SCALE_BENCH_IDENTITY_ENV,
  SCALE_BENCH_TOKEN_ENV,
  SCALE_BENCH_URL_ENV,
} from "./bench-db-scale-target";

function environment(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    [SCALE_BENCH_IDENTITY_ENV]: "scale-scratch.example.invalid",
    [SCALE_BENCH_TOKEN_ENV]: "synthetic-token-value",
    [SCALE_BENCH_URL_ENV]: "libsql://scale-scratch.example.invalid",
    ...overrides,
  };

  return (name: string) => values[name];
}

describe("bench-db-scale hosted target gate", () => {
  it.each([SCALE_BENCH_URL_ENV, SCALE_BENCH_TOKEN_ENV, SCALE_BENCH_IDENTITY_ENV])(
    "requires %s before a target can be returned",
    (missing) => {
      expect(() =>
        resolveScaleBenchTarget({ readEnvironment: environment({ [missing]: undefined }) }),
      ).toThrow(/required/);
    },
  );

  it.each([
    "not-a-url",
    "file:scale-scratch.db",
    "http://scale-scratch.example.invalid",
    "https://scale-scratch.example.invalid",
    "libsql://user:password@scale-scratch.example.invalid",
    "libsql://scale-scratch.example.invalid/path",
    "libsql://scale-scratch.example.invalid?mode=write",
    "libsql://scale-scratch.example.invalid#fragment",
  ])("rejects a malformed or non-hosted database origin without network: %s", (url) => {
    expect(() =>
      resolveScaleBenchTarget({
        readEnvironment: environment({ [SCALE_BENCH_URL_ENV]: url }),
      }),
    ).toThrow();
  });

  it.each([
    "libsql://localhost",
    "libsql://127.0.0.1",
    "libsql://catalogue-prod.example.invalid",
    "libsql://production.example.invalid",
    "libsql://fluncle.example.invalid",
    "libsql://catalogue-dev.example.invalid",
    "libsql://catalogue-local.example.invalid",
  ])("retains the non-production denylist as defense in depth: %s", (url) => {
    const identity = new URL(url).host;

    expect(() =>
      resolveScaleBenchTarget({
        readEnvironment: environment({
          [SCALE_BENCH_IDENTITY_ENV]: identity,
          [SCALE_BENCH_URL_ENV]: url,
        }),
      }),
    ).toThrow(/production, development, or local/);
  });

  it.each([
    undefined,
    "scratch",
    "other-scratch.example.invalid",
    "scale-scratch.example.invalid ",
    "SCALE-SCRATCH.EXAMPLE.INVALID",
  ])("rejects anything except an exact independent host confirmation: %s", (identity) => {
    expect(() =>
      resolveScaleBenchTarget({
        readEnvironment: environment({ [SCALE_BENCH_IDENTITY_ENV]: identity }),
      }),
    ).toThrow();
  });

  it("does not read the token until the target identity is positively confirmed", () => {
    const readEnvironment = vi.fn(
      environment({ [SCALE_BENCH_IDENTITY_ENV]: "other-scratch.example.invalid" }),
    );

    expect(() => resolveScaleBenchTarget({ readEnvironment })).toThrow(/exactly match/);
    expect(readEnvironment).not.toHaveBeenCalledWith(SCALE_BENCH_TOKEN_ENV);
  });

  it("returns a positively confirmed target without constructing a client", () => {
    const readEnvironment = vi.fn(environment());

    expect(resolveScaleBenchTarget({ readEnvironment })).toEqual({
      authToken: "synthetic-token-value",
      identity: "scale-scratch.example.invalid",
      url: "libsql://scale-scratch.example.invalid",
    });
    expect(readEnvironment).toHaveBeenCalledWith(SCALE_BENCH_URL_ENV);
    expect(readEnvironment).toHaveBeenCalledWith(SCALE_BENCH_TOKEN_ENV);
    expect(readEnvironment).toHaveBeenCalledWith(SCALE_BENCH_IDENTITY_ENV);
  });

  it("places positive confirmation before client construction and every hosted mutation", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./bench-db-scale.ts", import.meta.url)),
      "utf8",
    );
    const guardAt = source.indexOf("const target = readScaleBenchTarget();");
    const clientAt = source.indexOf("const client = createClient(");
    const migrationAt = source.indexOf("await migrate(");
    const seedAt = source.indexOf("await seedScale(");
    const proofAt = source.indexOf("await proveItem(");

    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(clientAt).toBeGreaterThan(guardAt);
    expect(migrationAt).toBeGreaterThan(clientAt);
    expect(seedAt).toBeGreaterThan(clientAt);
    expect(proofAt).toBeGreaterThan(clientAt);
  });
});
