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
  positionals: string[];
  flags: ParsedFlags<S>;
};

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
