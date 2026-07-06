// A minimal typed CLI flag parser shared by the pipeline entrypoints
// (ship.ts, social-preview.ts) so `--flag <value>` handling can't drift between
// them. No dependency — the flag surface here is small enough to own directly.
//
// Usage:
//   const { flags, positionals } = parseArgs(process.argv.slice(2), {
//     "skip-render": "boolean",
//     "duration-ms": "number",
//     composition: "string",
//   });
//
// Boolean flags are present/absent (`--draft` -> true, absent -> false).
// Number/string flags consume the NEXT token as their value
// (`--duration-ms 20000`); absent -> undefined. An unrecognized `--flag` or a
// value-flag missing its value both throw — a typo should fail loudly, not
// silently no-op.

export type FlagKind = "boolean" | "number" | "string";

export type FlagSchema = Record<string, FlagKind>;

type FlagValue<K extends FlagKind> = K extends "boolean"
  ? boolean
  : K extends "number"
    ? number | undefined
    : string | undefined;

export type ParsedFlags<S extends FlagSchema> = {
  [K in keyof S]: FlagValue<S[K]>;
};

export type ParsedArgs<S extends FlagSchema> = {
  /** Positional arguments, in order, with recognized flags + their values removed. */
  positionals: string[];
  flags: ParsedFlags<S>;
};

/**
 * Parse `argv` (already sliced past the script name, i.e. `process.argv.slice(2)`)
 * against `schema`. Throws on an unrecognized `--flag` or a value-flag with no
 * following token.
 */
export function parseArgs<S extends FlagSchema>(argv: string[], schema: S): ParsedArgs<S> {
  const flags: Record<string, boolean | number | string | undefined> = {};
  for (const [name, kind] of Object.entries(schema)) {
    flags[name] = kind === "boolean" ? false : undefined;
  }

  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) {
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const name = token.slice(2);
    const kind = schema[name];
    if (!kind) {
      throw new Error(`unknown flag --${name}`);
    }

    if (kind === "boolean") {
      flags[name] = true;
      continue;
    }

    const raw = argv[i + 1];
    if (raw === undefined) {
      throw new Error(`--${name} requires a value`);
    }
    i++;
    flags[name] = kind === "number" ? Number(raw) : raw;
  }

  return { flags: flags as ParsedFlags<S>, positionals };
}
