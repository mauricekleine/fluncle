import { getPreferenceValues } from "@raycast/api";
import { execFile } from "node:child_process";

type Preferences = {
  flunclePath: string;
};

export type AddResult = {
  ok: true;
  track: {
    trackId: string;
    spotifyUrl: string;
    title: string;
    artists: string[];
    album?: string;
    durationMs: number;
  };
  dryRun: boolean;
  addedToSpotify: boolean;
  postedToTelegram: boolean;
  message: string;
};

export type RecentTransmission = {
  trackId: string;
  spotifyUrl: string;
  title: string;
  artists: string[];
  album?: string;
  note?: string;
  addedAt: string;
  addedToSpotify: boolean;
  postedToTelegram: boolean;
};

type RecentResult = {
  ok: true;
  transmissions: RecentTransmission[];
};

type FluncleFailure = {
  ok: false;
  code: string;
  message: string;
};

export class FluncleCommandError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FluncleCommandError";
    this.code = code;
  }
}

export function getFlunclePath(): string {
  return getPreferenceValues<Preferences>().flunclePath;
}

export async function addTrack(url: string, note?: string): Promise<AddResult> {
  const args = ["add", url, "--json"];

  if (note?.trim()) {
    args.push("--note", note.trim());
  }

  return runFluncleJson<AddResult>(args);
}

export async function getRecentTransmissions(
  limit = 20,
): Promise<RecentTransmission[]> {
  const result = await runFluncleJson<RecentResult>([
    "recent",
    "--limit",
    String(limit),
    "--json",
  ]);

  return result.transmissions;
}

export function isSpotifyTrackInput(input: string | undefined): boolean {
  if (!input) {
    return false;
  }

  return parseSpotifyTrackInput(input) !== undefined;
}

export function parseSpotifyTrackInput(input: string): string | undefined {
  const value = input.trim();

  if (/^spotify:track:[A-Za-z0-9]{22}$/.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);
    const [kind, trackId] = url.pathname.split("/").filter(Boolean);

    if (
      url.hostname === "open.spotify.com" &&
      kind === "track" &&
      /^[A-Za-z0-9]{22}$/.test(trackId ?? "")
    ) {
      return value;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function runFluncleJson<T>(args: string[]): Promise<T> {
  const result = await execFluncle(args);
  const output = result.stdout.trim() || result.stderr.trim();

  if (!output) {
    throw new FluncleCommandError(
      "empty_output",
      "Fluncle did not return any output",
    );
  }

  let parsed: T | FluncleFailure;

  try {
    parsed = JSON.parse(output) as T | FluncleFailure;
  } catch {
    throw new FluncleCommandError("invalid_output", output);
  }

  if (isFailure(parsed)) {
    throw new FluncleCommandError(parsed.code, parsed.message);
  }

  return parsed;
}

function execFluncle(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      getFlunclePath(),
      args,
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && !stdout.trim()) {
          reject(
            new FluncleCommandError(
              "command_failed",
              stderr.trim() || error.message,
            ),
          );
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });
}

function isFailure(value: unknown): value is FluncleFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as { ok: unknown }).ok === false
  );
}
