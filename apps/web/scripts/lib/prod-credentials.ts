export const DEFAULT_TURSO_DB = "fluncle";
export const TURSO_TOKEN_EXPIRATION = "1d";

export type CredentialSource = "environment" | "1password" | "turso-cli";

export type ProductionCredentials = {
  authToken: string;
  describe: string;
  source: CredentialSource;
  url: string;
};

export type CommandRunner = (command: string[]) => Promise<string>;

export type CredentialEnv = Record<string, string | undefined> & {
  FLUNCLE_1PASSWORD_ACCOUNT?: string;
  FLUNCLE_TURSO_DB?: string;
  FLUNCLE_TURSO_OP_ITEM?: string;
  TURSO_AUTH_TOKEN?: string;
  TURSO_DATABASE_URL?: string;
};

export function opReference(item: string, field: string): string {
  const path = item
    .trim()
    .replace(/^op:\/\//, "")
    .replace(/\/+$/, "");

  return `op://${path}/${field}`;
}

export function opReadCommand(item: string, field: string, account?: string): string[] {
  const command = ["op", "read", opReference(item, field)];

  return account ? [...command, "--account", account] : command;
}

export function tursoUrlCommand(database: string): string[] {
  return ["turso", "db", "show", database, "--url"];
}

export function tursoTokenCommand(database: string): string[] {
  return [
    "turso",
    "db",
    "tokens",
    "create",
    database,
    "--read-only",
    "--expiration",
    TURSO_TOKEN_EXPIRATION,
  ];
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

function toolError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return message.trim() || "no error output";
}

async function readThrough(run: CommandRunner, command: string[], path: string): Promise<string> {
  let output: string;

  try {
    output = await run(command);
  } catch (error) {
    throw new Error(
      `Could not resolve production credentials through ${path}: \`${command.slice(0, 3).join(" ")}\` failed: ${toolError(error)}`,
    );
  }

  const value = output.trim();

  if (value === "") {
    throw new Error(
      `Could not resolve production credentials through ${path}: \`${command.slice(0, 3).join(" ")}\` printed nothing.`,
    );
  }

  return value;
}

export async function resolveProductionCredentials(
  env: CredentialEnv,
  run: CommandRunner,
): Promise<ProductionCredentials> {
  const envUrl = env.TURSO_DATABASE_URL;
  const envToken = env.TURSO_AUTH_TOKEN;
  const hasUrl = present(envUrl);
  const hasToken = present(envToken);

  if (present(envUrl) && present(envToken)) {
    return {
      authToken: envToken.trim(),
      describe: "TURSO_DATABASE_URL and TURSO_AUTH_TOKEN from the environment",
      source: "environment",
      url: envUrl.trim(),
    };
  }

  if (hasUrl !== hasToken) {
    const missing = hasUrl ? "TURSO_AUTH_TOKEN" : "TURSO_DATABASE_URL";

    throw new Error(
      `${hasUrl ? "TURSO_DATABASE_URL" : "TURSO_AUTH_TOKEN"} is set but ${missing} is not. Set both, or unset both to fall back to FLUNCLE_TURSO_OP_ITEM or the turso CLI.`,
    );
  }

  if (present(env.FLUNCLE_TURSO_OP_ITEM)) {
    const item = env.FLUNCLE_TURSO_OP_ITEM;
    const account = present(env.FLUNCLE_1PASSWORD_ACCOUNT)
      ? env.FLUNCLE_1PASSWORD_ACCOUNT.trim()
      : undefined;
    const path = `1Password (FLUNCLE_TURSO_OP_ITEM${account ? ", FLUNCLE_1PASSWORD_ACCOUNT" : ""})`;
    const url = await readThrough(run, opReadCommand(item, "TURSO_DATABASE_URL", account), path);
    const authToken = await readThrough(
      run,
      opReadCommand(item, "TURSO_AUTH_TOKEN", account),
      path,
    );

    return {
      authToken,
      describe: `the 1Password item named by FLUNCLE_TURSO_OP_ITEM${account ? " in the FLUNCLE_1PASSWORD_ACCOUNT account" : ""}`,
      source: "1password",
      url,
    };
  }

  const database = present(env.FLUNCLE_TURSO_DB) ? env.FLUNCLE_TURSO_DB.trim() : DEFAULT_TURSO_DB;
  const path = `the turso CLI (database ${database})`;
  const url = await readThrough(run, tursoUrlCommand(database), path);
  const authToken = await readThrough(run, tursoTokenCommand(database), path);

  return {
    authToken,
    describe: `the turso CLI: database ${database}, a read-only token that expires in ${TURSO_TOKEN_EXPIRATION}`,
    source: "turso-cli",
    url,
  };
}
