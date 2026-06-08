import { CliError } from "../output";
import { type RecentTrack, recentCommand } from "./recent";

const SPOTIFY_PLAYLIST_URL =
  "https://open.spotify.com/playlist/1m5LADqpLjiBERdtqrIiL0?si=054d3c6cbcf14a36";
const TELEGRAM_URL = "https://t.me/fluncle";

const TELEGRAM_APP_URI = "tg://resolve?domain=fluncle";

export type OpenMode = "app" | "browser" | "default";

type OpenRecentOptions = {
  limit: number;
  mode: OpenMode;
};

export async function openPlaylistCommand(mode: OpenMode): Promise<void> {
  const target =
    mode === "browser" ? SPOTIFY_PLAYLIST_URL : spotifyPlaylistUrlToAppUri(SPOTIFY_PLAYLIST_URL);
  await openExternal(target);
}

export async function openTelegramCommand(mode: OpenMode): Promise<void> {
  const target = mode === "browser" ? TELEGRAM_URL : TELEGRAM_APP_URI;
  await openExternal(target);
}

export async function openRecentCommand(options: OpenRecentOptions): Promise<void> {
  const tracks = await recentCommand(options.limit);

  if (tracks.length === 0) {
    console.log("No findings logged yet.");
    return;
  }

  const selected = await selectRecentTrack(tracks);

  if (!selected) {
    return;
  }

  const target =
    options.mode === "browser" ? selected.spotifyUrl : `spotify:track:${selected.trackId}`;
  await openExternal(target);
}

export function spotifyPlaylistUrlToAppUri(playlistUrl: string): string {
  const playlistId = playlistUrl.match(/open\.spotify\.com\/playlist\/([^/?#]+)/)?.[1];

  if (!playlistId) {
    throw new CliError(
      "invalid_playlist_url",
      `Could not parse Spotify playlist URL: ${playlistUrl}`,
    );
  }

  return `spotify:playlist:${playlistId}`;
}

async function openExternal(target: string): Promise<void> {
  const command = platformOpenCommand();

  if (!command) {
    console.log(target);
    throw new CliError(
      "unsupported_platform",
      `Automatic opening is only supported on macOS and Linux. Open this manually: ${target}`,
    );
  }

  const child = Bun.spawn([command, target], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const exitCode = await child.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new CliError("open_failed", stderr.trim() || `Could not open ${target} with ${command}`);
  }
}

function platformOpenCommand(): string | undefined {
  if (process.platform === "darwin") {
    return "open";
  }

  if (process.platform === "linux") {
    return "xdg-open";
  }

  return undefined;
}

async function selectRecentTrack(tracks: RecentTrack[]): Promise<RecentTrack | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      "not_interactive",
      "fluncle open requires an interactive terminal. Use fluncle recent to list tracks.",
    );
  }

  let selectedIndex = 0;
  let renderedLines = 0;
  let done = false;

  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasRaw = stdin.isRaw === true;

  return await new Promise<RecentTrack | undefined>((resolve) => {
    function cleanup(): void {
      if (done) {
        return;
      }

      done = true;
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write("\x1b[?25h");
    }

    function finish(track?: RecentTrack): void {
      cleanup();
      stdout.write(renderedLines > 0 ? "\n" : "");
      resolve(track);
    }

    function cancel(): void {
      cleanup();
      clearRendered(stdout, renderedLines);
      stdout.write("Cancelled.\n");
      resolve(undefined);
    }

    function render(): void {
      clearRendered(stdout, renderedLines);
      const lines = buildSelectorLines(tracks, selectedIndex, stdout.columns ?? 80);
      renderedLines = lines.length;
      stdout.write(`${lines.join("\n")}\n`);
    }

    function onData(chunk: Buffer): void {
      const input = chunk.toString("utf8");

      if (input === "\u0003" || input === "\u001b" || input === "q") {
        cancel();
        return;
      }

      if (input === "\r" || input === "\n") {
        finish(tracks[selectedIndex]);
        return;
      }

      if (input === "\u001b[A" || input === "k") {
        selectedIndex = selectedIndex === 0 ? tracks.length - 1 : selectedIndex - 1;
        render();
        return;
      }

      if (input === "\u001b[B" || input === "j") {
        selectedIndex = selectedIndex === tracks.length - 1 ? 0 : selectedIndex + 1;
        render();
      }
    }

    stdout.write("\x1b[?25l");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render();
  });
}

function clearRendered(stdout: NodeJS.WriteStream, lineCount: number): void {
  if (lineCount === 0) {
    return;
  }

  stdout.write(`\x1b[${lineCount}F\x1b[J`);
}

function buildSelectorLines(
  tracks: RecentTrack[],
  selectedIndex: number,
  columns: number,
): string[] {
  return [
    "Select a track to open in Spotify",
    ...tracks.map((track, index) => {
      const prefix = index === selectedIndex ? "> " : "  ";
      const label = `${track.artists.join(", ")} — ${track.title}`;
      const line = truncate(`${prefix}${label}`, Math.max(columns, 20));

      return index === selectedIndex ? `\x1b[7m${line}\x1b[0m` : line;
    }),
    "",
    "Enter: open  Up/k Down/j  q/Esc: cancel",
  ];
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(maxLength - 3, 0))}...`;
}
