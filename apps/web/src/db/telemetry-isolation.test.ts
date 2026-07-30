import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// THE TWO DATABASES MUST NOT BE ABLE TO REACH EACH OTHER. A telemetry migration applied
// to the primary (or a primary migration applied to `fluncle-telemetry`) is not a bug you
// discover from behaviour — drizzle-kit would apply a `run_events` CREATE TABLE to the
// primary perfectly happily, stamp its journal, and leave two databases each holding half
// a history. There is no undo for that, so the separation is asserted rather than trusted.
//
// The isolation rests on FOUR facts, one per assertion below: two configs, two `out`
// folders, two `schema` entrypoints, and two disjoint credential env pairs. A copy-paste
// in either config — the likeliest way this breaks, since the second was born as a copy of
// the first — trips one of them.
//
// Asserted over the config SOURCE TEXT, not over the imported configs: importing
// `drizzle.config.ts` calls `requireEnv` and would pull the operator's real credentials
// into the test process (and throw in CI, where they are absent). The env var NAMES are
// what matters, and the text carries them.

const PRIMARY = "drizzle.config.ts";
const TELEMETRY = "drizzle-telemetry.config.ts";

function configSource(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), "utf8");
}

/** The `out:` / `schema:` value a drizzle config declares. */
function declared(source: string, key: "out" | "schema"): string {
  const match = new RegExp(`${key}:\\s*"([^"]+)"`).exec(source);

  expect(match?.[1]).toBeTruthy();

  return match?.[1] ?? "";
}

/** Every `TURSO_*` env name a config reads. The credential pair, by name only. */
function tursoEnvNames(source: string): string[] {
  return [...new Set(source.match(/TURSO_[A-Z_]+/g) ?? [])].sort();
}

describe("the primary and telemetry drizzle configs are disjoint", () => {
  const primary = configSource(PRIMARY);
  const telemetry = configSource(TELEMETRY);

  it("write to DIFFERENT migration folders", () => {
    // The folder is what `drizzle-kit migrate` replays. Sharing one would mean a telemetry
    // migration is in the primary's chain and would run against it on the next deploy.
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
    // The one that actually decides which database a migration lands in. `TURSO_TELEMETRY_*`
    // deliberately does NOT prefix-match `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`.
    const primaryEnv = tursoEnvNames(primary);
    const telemetryEnv = tursoEnvNames(telemetry);

    expect(primaryEnv).toEqual(["TURSO_AUTH_TOKEN", "TURSO_DATABASE_URL"]);
    expect(telemetryEnv).toEqual(["TURSO_TELEMETRY_AUTH_TOKEN", "TURSO_TELEMETRY_DATABASE_URL"]);
    expect(primaryEnv.filter((name) => telemetryEnv.includes(name))).toEqual([]);
  });

  it("keeps the telemetry schema out of the primary's module graph", () => {
    // `src/db/schema.ts` must never import the telemetry table: `drizzle-kit generate`
    // walks the schema entrypoint's imports, so one import would put `run_events` into the
    // PRIMARY's next generated migration.
    const schema = readFileSync(fileURLToPath(new URL("./schema.ts", import.meta.url)), "utf8");

    expect(schema).not.toContain("telemetry-schema");
  });
});
