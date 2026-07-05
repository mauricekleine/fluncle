// The ~/Movies scan, pure half — file classification, newest-first ordering,
// ffprobe duration parsing, and the smart take defaults read off a capture's
// filename. Pinned by scan.test.ts. The daemon's server.ts does the readdir +
// spawns ffprobe; everything testable lives here.

/** The capture masters OBS writes (the recording upload's --video source). */
export const SET_VIDEO_EXTENSIONS = [".mov", ".mkv", ".mp4"] as const;

/** The mix masters distribute pushes to Mixcloud (--audio). */
export const MASTER_AUDIO_EXTENSIONS = [".mp3", ".m4a", ".wav", ".aac", ".flac"] as const;

function hasExtension(name: string, extensions: readonly string[]): boolean {
  const lower = name.toLowerCase();

  return extensions.some((extension) => lower.endsWith(extension));
}

/** A candidate set-video capture: a real video file, never a dotfile (`.DS_Store`). */
export function isSetVideoFile(name: string): boolean {
  return !name.startsWith(".") && hasExtension(name, SET_VIDEO_EXTENSIONS);
}

/** A candidate audio master for distribution. */
export function isMasterAudioFile(name: string): boolean {
  return !name.startsWith(".") && hasExtension(name, MASTER_AUDIO_EXTENSIONS);
}

/** One scanned file the picker lists. */
export type MovieEntry = {
  durationMs?: number;
  modifiedMs: number;
  name: string;
  path: string;
  sizeBytes: number;
};

/** Newest capture first — the operator's most recent set is the one they just cut. */
export function sortMoviesNewestFirst(entries: readonly MovieEntry[]): MovieEntry[] {
  return [...entries].sort((a, b) => b.modifiedMs - a.modifiedMs);
}

/**
 * Duration (ms) from `ffprobe -v quiet -print_format json -show_format`. The
 * `format.duration` is seconds as a string; anything missing or unparseable reads
 * as absent (a duration the picker just doesn't show), never a throw.
 */
export function parseFfprobeDurationMs(stdout: string): number | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const format = (parsed as { format?: unknown }).format;

  if (typeof format !== "object" || format === null) {
    return undefined;
  }

  const raw = (format as { duration?: unknown }).duration;
  const seconds =
    typeof raw === "string" ? Number.parseFloat(raw) : typeof raw === "number" ? raw : NaN;

  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }

  return Math.round(seconds * 1000);
}

export type TakeDefaults = {
  recordedAt: string;
  title: string;
};

// OBS names a capture `YYYY-MM-DD HH-MM-SS.<ext>` (a space or underscore between
// date and time). That prefix is the recorded instant; the operator can override.
const CAPTURE_STAMP = /^(\d{4})-(\d{2})-(\d{2})[ _](\d{2})-(\d{2})-(\d{2})/;

/**
 * The take's title + recorded-date defaults read off its filename, falling back to
 * the file's own modified time when the name carries no stamp. The date is a local
 * wall-clock instant (the set happened where the operator is), serialized ISO.
 */
export function takeDefaultsFromFilename(name: string, modifiedMs: number): TakeDefaults {
  const stamp = CAPTURE_STAMP.exec(name);

  if (stamp) {
    const [, year, month, day, hour, minute, second] = stamp;
    const when = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );

    return { recordedAt: when.toISOString(), title: `Set — ${year}-${month}-${day}` };
  }

  const fallback = new Date(modifiedMs);
  const dateLabel = Number.isFinite(modifiedMs) ? fallback.toISOString().slice(0, 10) : "";
  const bareName = name.replace(/\.[^.]+$/, "");

  return {
    recordedAt: Number.isFinite(modifiedMs) ? fallback.toISOString() : "",
    title: dateLabel ? `Set — ${dateLabel}` : bareName,
  };
}
