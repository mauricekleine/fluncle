import { artistTitle, coordinate } from "../format";
import { selectWithKeyboard, truncateTerminalLine } from "../interactive";
import { CliError } from "../output";
import { type RecentTrack, recentCommand } from "./recent";

const SPOTIFY_PLAYLIST_URL =
  "https://open.spotify.com/playlist/1m5LADqpLjiBERdtqrIiL0?si=054d3c6cbcf14a36";
const TELEGRAM_URL = "https://t.me/fluncle";

const TELEGRAM_APP_URI = "tg://resolve?domain=fluncle";
const SELECT_NON_INTERACTIVE_MESSAGE =
  "fluncle open requires an interactive terminal. Use fluncle recent to list tracks.";

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
  const tracks = (await recentCommand(options.limit)).filter(
    (item): item is RecentTrack => item.type !== "mixtape",
  );

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

function spotifyPlaylistUrlToAppUri(playlistUrl: string): string {
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
  return await selectWithKeyboard(tracks, {
    nonInteractiveMessage: SELECT_NON_INTERACTIVE_MESSAGE,
    renderLines: buildSelectorLines,
  });
}

function buildSelectorLines(
  tracks: RecentTrack[],
  selectedIndex: number,
  columns: number,
): string[] {
  const coordWidth = tracks.reduce((width, track) => {
    return Math.max(width, coordinate(track).length);
  }, 0);

  return [
    "Select a track to open in Spotify",
    ...tracks.map((track, index) => {
      const prefix = index === selectedIndex ? "> " : "  ";
      const label = `${coordinate(track).padEnd(coordWidth)}  ${artistTitle(track)}`;
      const line = truncateTerminalLine(`${prefix}${label}`, Math.max(columns, 20));

      return index === selectedIndex ? `\x1b[7m${line}\x1b[0m` : line;
    }),
    "",
    "Enter: open  Up/k Down/j  q/Esc: cancel",
  ];
}
