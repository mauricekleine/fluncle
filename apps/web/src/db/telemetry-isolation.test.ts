import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PRIMARY = "drizzle.config.ts";
const TELEMETRY = "drizzle-telemetry.config.ts";

function configSource(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), "utf8");
}

function declared(source: string, key: "out" | "schema"): string {
  const match = new RegExp(`${key}:\\s*"([^"]+)"`).exec(source);

  expect(match?.[1]).toBeTruthy();

  return match?.[1] ?? "";
}

function tursoEnvNames(source: string): string[] {
  return [...new Set(source.match(/TURSO_[A-Z_]+/g) ?? [])].sort();
}

describe("the primary and telemetry drizzle configs are disjoint", () => {
  const primary = configSource(PRIMARY);
  const telemetry = configSource(TELEMETRY);

  it("write to DIFFERENT migration folders", () => {
    expect(declared(primary, "out")).toBe("./drizzle");
    expect(declared(telemetry, "out")).toBe("./drizzle-telemetry");
    expect(declared(primary, "out")).not.toBe(declared(telemetry, "out"));
  });

  it("diff DIFFERENT schema entrypoints", () => {
    expect(declared(primary, "schema")).toBe("./src/db/schema.ts");
    expect(declared(telemetry, "schema")).toBe("./src/db/telemetry-schema.ts");
    expect(declared(primary, "schema")).not.toBe(declared(telemetry, "schema"));
  });

  it("dial DIFFERENT databases — the credential pairs share no env name", () => {
    const primaryEnv = tursoEnvNames(primary);
    const telemetryEnv = tursoEnvNames(telemetry);

    expect(primaryEnv).toEqual(["TURSO_AUTH_TOKEN", "TURSO_DATABASE_URL"]);
    expect(telemetryEnv).toEqual(["TURSO_TELEMETRY_AUTH_TOKEN", "TURSO_TELEMETRY_DATABASE_URL"]);
    expect(primaryEnv.filter((name) => telemetryEnv.includes(name))).toEqual([]);
  });

  it("keeps the telemetry schema out of the primary's module graph", () => {
    const schema = readFileSync(fileURLToPath(new URL("./schema.ts", import.meta.url)), "utf8");

    expect(schema).not.toContain("telemetry-schema");
  });
});
