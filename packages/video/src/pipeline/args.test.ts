import { describe, expect, test } from "bun:test";

import { parseArgs } from "./args";

describe("parseArgs", () => {
  test("parses boolean, number, and string flags alongside a positional", () => {
    const { flags, positionals } = parseArgs(
      ["trackId123", "--skip-render", "--duration-ms", "20000", "--aspect", "landscape"],
      { aspect: "string", "duration-ms": "number", "skip-render": "boolean" },
    );

    expect(positionals).toEqual(["trackId123"]);
    expect(flags["skip-render"]).toBe(true);
    expect(flags["duration-ms"]).toBe(20000);
    expect(flags.aspect).toBe("landscape");
  });

  test("defaults booleans to false and value flags to undefined when absent", () => {
    const { flags } = parseArgs([], { draft: "boolean", vehicle: "string" });

    expect(flags.draft).toBe(false);
    expect(flags.vehicle).toBeUndefined();
  });

  test("collects multiple positionals in encounter order, skipping flag values", () => {
    const { positionals } = parseArgs(["a", "--duration-ms", "1", "b"], {
      "duration-ms": "number",
    });

    expect(positionals).toEqual(["a", "b"]);
  });

  test("throws on an unrecognized flag", () => {
    expect(() => parseArgs(["--bogus"], {})).toThrow("unknown flag --bogus");
  });

  test("throws when a value flag has no following token", () => {
    expect(() => parseArgs(["--vehicle"], { vehicle: "string" })).toThrow(
      "--vehicle requires a value",
    );
  });

  test("a trailing boolean flag needs no following token", () => {
    const { flags } = parseArgs(["--draft"], { draft: "boolean" });

    expect(flags.draft).toBe(true);
  });

  test("number coercion applies Number() to the raw token", () => {
    const { flags } = parseArgs(["--n", "not-a-number"], { n: "number" });

    expect(Number.isNaN(flags.n)).toBe(true);
  });
});
