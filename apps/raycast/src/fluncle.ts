import { type AddTrackResponse, type ApiFailure, type TrackListItem } from "@fluncle/contracts";
import { getPreferenceValues } from "@raycast/api";
import { execFile } from "node:child_process";

type Preferences = {
  flunclePath: string;
};

export type AddResult = AddTrackResponse;

export type RecentTrack = Pick<
  TrackListItem,
  | "addedAt"
  | "addedToSpotify"
  | "album"
  | "albumImageUrl"
  | "artists"
  | "note"
  | "postedToTelegram"
  | "spotifyUrl"
  | "title"
  | "trackId"
>;

type RecentResult = {
  ok: true;
  tracks: RecentTrack[];
};

class FluncleCommandError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FluncleCommandError";
    this.code = code;
  }
}

function getFlunclePath(): string {
  return getPreferenceValues<Preferences>().flunclePath;
}

export async function addTrack(url: string, note?: string): Promise<AddResult> {
  const args = ["admin", "add", url, "--json"];

  if (note?.trim()) {
    args.push("--note", note.trim());
  }

  return runFluncleJson<AddResult>(args);
}

export async function getRecentTracks(limit = 20): Promise<RecentTrack[]> {
  const result = await runFluncleJson<RecentResult>(["recent", "--limit", String(limit), "--json"]);

  return result.tracks;
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
    throw new FluncleCommandError("empty_output", "Fluncle did not return any output");
  }

  let parsed: ApiFailure | T;

  try {
    parsed = JSON.parse(output) as ApiFailure | T;
  } catch {
    throw new FluncleCommandError("invalid_output", output);
  }

  if (isFailure(parsed)) {
    throw new FluncleCommandError(parsed.code, parsed.message);
  }

  return parsed;
}

function execFluncle(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      getFlunclePath(),
      args,
      {
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        if (error && !stdout.trim()) {
          reject(new FluncleCommandError("command_failed", stderr.trim() || error.message));
          return;
        }

        resolve({ stderr, stdout });
      },
    );
  });
}

function isFailure(value: unknown): value is ApiFailure {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}
