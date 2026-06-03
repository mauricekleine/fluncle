#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { formatError } from "./retry";

async function main(): Promise<void> {
  const [command, subcommand, ...rest] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "add") {
    const { addCommand } = await import("./commands/add");
    await runAdd([subcommand, ...rest].filter(Boolean), addCommand);
    return;
  }

  if (command === "auth" && subcommand === "spotify") {
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
    args,
    allowPositionals: true,
    options: {
      note: {
        type: "string",
      },
      "dry-run": {
        type: "boolean",
        default: false,
      },
    },
  });

  const spotifyUrl = parsed.positionals[0];

  if (!spotifyUrl) {
    throw new Error("Missing Spotify track URL");
  }

  await addCommand(spotifyUrl, {
    note: parsed.values.note,
    dryRun: parsed.values["dry-run"],
  });
}

function printHelp(): void {
  console.log(`fluncle

Commands:
  fluncle add <spotify-url> [--note "text"] [--dry-run]
  fluncle auth spotify`);
}

main().catch((error) => {
  console.error(formatError(error));
  process.exit(1);
});
