#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { setEnvProfile } from "./env";
import { printJson, toJsonFailure } from "./output";
import { formatError } from "./retry";

type GlobalOptions = {
  args: string[];
  envProfile?: string;
};

async function main(): Promise<void> {
  const globalOptions = parseGlobalOptions(process.argv.slice(2));
  setEnvProfile(globalOptions.envProfile);

  const [command, subcommand, ...rest] = globalOptions.args;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "recent") {
    const { recentCommand } = await import("./commands/recent");
    await runRecent([subcommand, ...rest].filter(Boolean), recentCommand);
    return;
  }

  if (command === "open") {
    const openCommands = await import("./commands/open");
    await runOpen([subcommand, ...rest].filter(Boolean), openCommands);
    return;
  }

  if (command === "version") {
    const { versionCommand } = await import("./version");
    await runVersion([subcommand, ...rest].filter(Boolean), versionCommand);
    return;
  }

  if (command === "admin" && subcommand === "add") {
    const { addCommand } = await import("./commands/add");
    await runAdd(rest, addCommand);
    return;
  }

  if (command === "admin" && subcommand === "auth" && rest[0] === "spotify") {
    const { authSpotifyCommand } = await import("./commands/auth");
    await authSpotifyCommand();
    return;
  }

  throw new Error(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
}

async function runAdd(
  args: string[],
  addCommand: typeof import("./commands/add").addCommand,
): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    args,
    options: {
      "dry-run": {
        default: false,
        type: "boolean",
      },
      json: {
        default: false,
        type: "boolean",
      },
      note: {
        type: "string",
      },
    },
  });

  const spotifyUrl = parsed.positionals[0];

  if (!spotifyUrl) {
    throw new Error("Missing Spotify track URL");
  }

  const result = await addCommand(spotifyUrl, {
    dryRun: parsed.values["dry-run"],
    json: parsed.values.json,
    note: parsed.values.note,
  });

  if (parsed.values.json) {
    printJson({
      ok: true,
      ...result,
    });
  }
}

async function runRecent(
  args: string[],
  recentCommand: typeof import("./commands/recent").recentCommand,
): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: false,
    args,
    options: {
      json: {
        default: false,
        type: "boolean",
      },
      limit: {
        default: "10",
        type: "string",
      },
    },
  });

  const limit = Number.parseInt(parsed.values.limit ?? "10", 10);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Limit must be an integer between 1 and 100");
  }

  const transmissions = await recentCommand(limit);

  if (parsed.values.json) {
    printJson({
      ok: true,
      transmissions,
    });
    return;
  }

  console.log(
    transmissions.map((track) => `${track.artists.join(", ")} — ${track.title}`).join("\n"),
  );
}

async function runOpen(
  args: string[],
  openCommands: typeof import("./commands/open"),
): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    args,
    options: {
      app: {
        default: false,
        type: "boolean",
      },
      browser: {
        default: false,
        type: "boolean",
      },
      limit: {
        default: "20",
        type: "string",
      },
    },
  });

  if (parsed.values.app && parsed.values.browser) {
    throw new Error("Use either --app or --browser, not both");
  }

  const mode: import("./commands/open").OpenMode = parsed.values.browser
    ? "browser"
    : parsed.values.app
      ? "app"
      : "default";
  const [target, extra] = parsed.positionals;

  if (extra) {
    throw new Error(`Unknown open target: ${parsed.positionals.join(" ")}`);
  }

  if (target === "playlist") {
    await openCommands.openPlaylistCommand(mode);
    return;
  }

  if (target === "telegram") {
    await openCommands.openTelegramCommand(mode);
    return;
  }

  if (target) {
    throw new Error(`Unknown open target: ${target}`);
  }

  const limit = Number.parseInt(parsed.values.limit ?? "20", 10);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Limit must be an integer between 1 and 100");
  }

  await openCommands.openRecentCommand({
    limit,
    mode,
  });
}

async function runVersion(
  args: string[],
  versionCommand: typeof import("./version").versionCommand,
): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: false,
    args,
    options: {
      check: {
        default: false,
        type: "boolean",
      },
      json: {
        default: false,
        type: "boolean",
      },
    },
  });

  await versionCommand({
    check: parsed.values.check,
    json: parsed.values.json,
  });
}

function printHelp(): void {
  console.log(`fluncle

Global options:
  --env <local|production>  Config profile to load (default: production)

Commands:
  fluncle recent [--limit 10] [--json]
  fluncle open [--limit 20] [--browser|--app]
  fluncle open playlist [--browser|--app]
  fluncle open telegram [--browser|--app]
  fluncle version [--check] [--json]
  fluncle admin add <spotify-url> [--note "text"] [--dry-run] [--json]
  fluncle admin auth spotify`);
}

function parseGlobalOptions(args: string[]): GlobalOptions {
  const cleanedArgs: string[] = [];
  let envProfile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--env") {
      envProfile = args[index + 1];

      if (!envProfile) {
        throw new Error("Missing value for --env");
      }

      index += 1;
      continue;
    }

    if (arg.startsWith("--env=")) {
      envProfile = arg.slice("--env=".length);
      continue;
    }

    cleanedArgs.push(arg);
  }

  return {
    args: cleanedArgs,
    envProfile,
  };
}

main().catch((error) => {
  if (process.argv.includes("--json")) {
    printJson(toJsonFailure(error));
  } else {
    console.error(formatError(error));
  }
  process.exit(1);
});
