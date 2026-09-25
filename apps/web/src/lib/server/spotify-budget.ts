import { getSetting, setSetting } from "./settings";

export const SPOTIFY_CALLS_WINDOW_START_KEY = "spotify_calls_window_start";

export const SPOTIFY_CALLS_WINDOW_COUNT_KEY = "spotify_calls_window_count";

export const SPOTIFY_CALL_WINDOW_MS = 30 * 1000;

export const SPOTIFY_CALL_WINDOW_MAX = 24;

function parseCount(raw: string | undefined, fallback = 0): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return fallback;
  }

  const parsed = Number(raw.trim());

  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function spotifyCallWindow(input: { count: number; now: number; startMs: number }): {
  count: number;

  live: boolean;

  msUntilReset: number;
} {
  const { count, now, startMs } = input;

  if (!Number.isFinite(startMs) || now - startMs >= SPOTIFY_CALL_WINDOW_MS) {
    return { count: 0, live: false, msUntilReset: 0 };
  }

  return { count, live: true, msUntilReset: SPOTIFY_CALL_WINDOW_MS - (now - startMs) };
}

async function readSpotifyCallWindow(
  now: number,
): Promise<{ count: number; msUntilReset: number }> {
  const [start, count] = await Promise.all([
    getSetting(SPOTIFY_CALLS_WINDOW_START_KEY),
    getSetting(SPOTIFY_CALLS_WINDOW_COUNT_KEY),
  ]);

  const startMs = start ? Date.parse(start) : Number.NaN;
  const window = spotifyCallWindow({ count: parseCount(count), now, startMs });

  return { count: window.count, msUntilReset: window.msUntilReset };
}

export async function readSpotifyCallCount(now: number = Date.now()): Promise<number> {
  return (await readSpotifyCallWindow(now)).count;
}

export async function isSpotifyCallBudgetAvailable(now: number = Date.now()): Promise<boolean> {
  try {
    return (await readSpotifyCallWindow(now)).count < SPOTIFY_CALL_WINDOW_MAX;
  } catch {
    return true;
  }
}

export async function recordSpotifyCall(now: number = Date.now()): Promise<void> {
  const [start, count] = await Promise.all([
    getSetting(SPOTIFY_CALLS_WINDOW_START_KEY),
    getSetting(SPOTIFY_CALLS_WINDOW_COUNT_KEY),
  ]);

  const startMs = start ? Date.parse(start) : Number.NaN;

  if (!Number.isFinite(startMs) || now - startMs >= SPOTIFY_CALL_WINDOW_MS) {
    await Promise.all([
      setSetting(SPOTIFY_CALLS_WINDOW_START_KEY, new Date(now).toISOString()),
      setSetting(SPOTIFY_CALLS_WINDOW_COUNT_KEY, "1"),
    ]);

    return;
  }

  await setSetting(SPOTIFY_CALLS_WINDOW_COUNT_KEY, String(parseCount(count) + 1));
}
