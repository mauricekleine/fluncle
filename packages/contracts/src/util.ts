// Tiny shared RUNTIME helpers for the surfaces over the Fluncle API (the CLI binary
// and the web Worker). The `.` entry stays type-only (no runtime) for the zod-free
// extension/CLI-type consumers; this `/util` subpath is the one place a byte-shared
// pure helper lives, so a copy can't drift. Keep it zod-free and dependency-free —
// pure functions only.

/** `3:42` from milliseconds. The shared finding-duration formatter (web + CLI). */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** An `Error`'s message, or `String(value)` for a non-Error throw. The shared error-stringifier (web + CLI). */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
