#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { printJson, toJsonFailure } from "./output";
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

  if (command === "recent") {
    const { recentCommand } = await import("./commands/recent");
    await runRecent([subcommand, ...rest].filter(Boolean), recentCommand);
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

function printHelp(): void {
  console.log(`fluncle

Commands:
  fluncle add <spotify-url> [--note "text"] [--dry-run] [--json]
  fluncle recent [--limit 10] [--json]
  fluncle auth spotify`);
}

main().catch((error) => {
  if (process.argv.includes("--json")) {
    printJson(toJsonFailure(error));
  } else {
    console.error(formatError(error));
  }
  process.exit(1);
});
